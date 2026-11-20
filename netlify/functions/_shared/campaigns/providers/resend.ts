import { fetchWithTimeout, TimeoutError } from '../../fetchTimeout'
import { ProviderError, type DnsRecord, type DomainInfo, type EmailProvider, type NormalizedEvent, type ReceivedEmail } from './types'

/**
 * Adapter Resend (API REST, autenticazione con API key dell'organizzazione).
 * - Invio con header Idempotency-Key (validità 24 h lato Resend): un nuovo tentativo con la
 *   stessa chiave non produce un secondo invio.
 * - Nessun tracciamento di aperture o clic: non viene mai attivato.
 * - Webhook firmati (Svix) verificati in svix.ts; contenuto delle email ricevute letto via API.
 */
const API = 'https://api.resend.com'
const TIMEOUT_MS = 15_000

type Fetch = typeof fetch

async function call(fetchImpl: Fetch | undefined, apiKey: string, method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}) {
  if (!apiKey) throw new ProviderError('auth', 'missing_api_key')
  let res: Response
  try {
    res = await fetchWithTimeout(
      `${API}${path}`,
      {
        method,
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', 'user-agent': 'LeadFlowAI/1.0', ...extraHeaders },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      TIMEOUT_MS,
      fetchImpl,
    )
  } catch (err) {
    // Timeout o rete: esito sconosciuto → si ritenta con la stessa chiave di idempotenza.
    throw new ProviderError('transient', err instanceof TimeoutError ? 'provider_timeout' : 'provider_network')
  }
  let data: Record<string, unknown> = {}
  try {
    data = (await res.json()) as Record<string, unknown>
  } catch {
    /* corpo vuoto */
  }
  if (res.ok) return data
  const name = typeof data.name === 'string' ? data.name : `http_${res.status}`
  if (res.status === 401 || res.status === 403) throw new ProviderError('auth', name, res.status)
  if (res.status === 404) throw new ProviderError('not_found', name, res.status)
  if (res.status === 409 && name === 'concurrent_idempotent_requests') throw new ProviderError('transient', name, res.status)
  if (res.status === 409) throw new ProviderError('idempotency_conflict', name, res.status)
  if (res.status === 429 || res.status >= 500) throw new ProviderError('transient', name, res.status)
  throw new ProviderError('permanent', name, res.status)
}

function toDomain(d: Record<string, unknown>): DomainInfo {
  const records = Array.isArray(d.records) ? (d.records as Record<string, unknown>[]) : []
  return {
    id: String(d.id ?? ''),
    name: String(d.name ?? ''),
    status: String(d.status ?? 'not_started'),
    records: records.map(
      (r): DnsRecord => ({
        record: String(r.record ?? ''),
        name: String(r.name ?? ''),
        type: String(r.type ?? ''),
        value: String(r.value ?? '').slice(0, 2000),
        status: String(r.status ?? ''),
        ttl: r.ttl === undefined ? undefined : String(r.ttl),
        priority: typeof r.priority === 'number' ? r.priority : undefined,
      }),
    ),
  }
}

export function createResendProvider(fetchImpl?: Fetch): EmailProvider {
  return {
    id: 'resend',
    label: 'Resend',
    implemented: true,
    auth: 'api_key',
    docsUrl: 'https://resend.com/docs',
    notes: 'API key per organizzazione, dominio mittente verificato (SPF/DKIM), webhook firmati.',

    async createOrGetDomain(apiKey, domain) {
      try {
        const created = await call(fetchImpl, apiKey, 'POST', '/domains', { name: domain })
        return toDomain(created)
      } catch (err) {
        // Dominio già presente nell'account: lo cerchiamo nell'elenco invece di crearne un altro.
        if (!(err instanceof ProviderError) || err.kind !== 'permanent') throw err
        const list = await call(fetchImpl, apiKey, 'GET', '/domains')
        const found = (Array.isArray(list.data) ? (list.data as Record<string, unknown>[]) : []).find(
          (d) => String(d.name ?? '').toLowerCase() === domain.toLowerCase(),
        )
        if (!found) throw err
        return toDomain(await call(fetchImpl, apiKey, 'GET', `/domains/${encodeURIComponent(String(found.id))}`))
      }
    },

    async getDomain(apiKey, id) {
      return toDomain(await call(fetchImpl, apiKey, 'GET', `/domains/${encodeURIComponent(id)}`))
    },

    async requestVerification(apiKey, id) {
      await call(fetchImpl, apiKey, 'POST', `/domains/${encodeURIComponent(id)}/verify`)
    },

    async send(apiKey, email, idempotencyKey) {
      const data = await call(
        fetchImpl,
        apiKey,
        'POST',
        '/emails',
        {
          from: email.from,
          to: [email.to],
          subject: email.subject,
          text: email.text,
          html: email.html,
          ...(email.replyTo ? { reply_to: email.replyTo } : {}),
          headers: email.headers,
          tags: email.tags,
        },
        { 'Idempotency-Key': idempotencyKey.slice(0, 256) },
      )
      if (typeof data.id !== 'string') throw new ProviderError('transient', 'missing_message_id')
      return { id: data.id }
    },

    normalizeWebhook(payload) {
      const p = payload as { type?: unknown; created_at?: unknown; data?: Record<string, unknown> }
      if (!p || typeof p.type !== 'string' || !p.data || typeof p.data !== 'object') return null
      const d = p.data
      const occurredAt = typeof p.created_at === 'string' ? p.created_at : new Date().toISOString()
      if (p.type === 'email.received') {
        if (typeof d.email_id !== 'string') return null
        return {
          type: p.type,
          providerMessageId: null,
          occurredAt,
          detail: {},
          received: {
            emailId: d.email_id,
            from: String(d.from ?? ''),
            to: Array.isArray(d.to) ? d.to.map(String) : [],
            subject: typeof d.subject === 'string' ? d.subject : null,
            messageId: typeof d.message_id === 'string' ? d.message_id : null,
          },
        }
      }
      const bounce = (d.bounce ?? {}) as Record<string, unknown>
      const ev: NormalizedEvent = {
        type: p.type,
        providerMessageId: typeof d.email_id === 'string' ? d.email_id : null,
        occurredAt,
        detail:
          p.type === 'email.bounced'
            ? { bounce_type: String(bounce.type ?? 'Permanent'), bounce_subtype: String(bounce.subType ?? '').slice(0, 60) }
            : {},
      }
      return ev
    },

    async getReceived(apiKey, id) {
      const d = await call(fetchImpl, apiKey, 'GET', `/emails/receiving/${encodeURIComponent(id)}`)
      const headers: Record<string, string> = {}
      if (d.headers && typeof d.headers === 'object') {
        for (const [k, v] of Object.entries(d.headers as Record<string, unknown>)) {
          if (['in-reply-to', 'references', 'message-id', 'auto-submitted', 'x-autoreply', 'list-id'].includes(k.toLowerCase())) headers[k.toLowerCase()] = String(v).slice(0, 1000)
        }
      }
      return {
        id: String(d.id ?? id),
        from: String(d.from ?? ''),
        subject: typeof d.subject === 'string' ? d.subject : null,
        text: typeof d.text === 'string' ? d.text : null,
        html: typeof d.html === 'string' ? d.html : null,
        headers,
        receivedAt: typeof d.created_at === 'string' ? d.created_at : new Date().toISOString(),
      } satisfies ReceivedEmail
    },
  }
}
