import { json } from './_shared/http'
import { log } from './_shared/log'
import { campaignDeps } from './_shared/campaigns/deps'
import { handleProviderWebhook } from './_shared/campaigns/webhook'

/**
 * POST /api/webhooks/resend/:accountId — eventi di consegna e risposte ricevute.
 * Pubblico ma autenticato dalla firma Svix con il segreto dell'account.
 */
/** Contesto Netlify Functions v2 (solo i campi usati). */
type Context = { params?: Record<string, string> }

export default async (req: Request, context: Context): Promise<Response> => {
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)
  const accountId = context.params?.accountId ?? ''
  if (!/^[0-9a-f-]{36}$/i.test(accountId)) return json({ error: 'not_found' }, 404)
  const raw = await req.text()
  if (raw.length > 256_000) return json({ error: 'payload_too_large' }, 413)
  try {
    const r = await handleProviderWebhook(campaignDeps(), accountId, raw, req.headers)
    return json(r.body, r.status)
  } catch (err) {
    log('error', 'webhook.error', { account_id: accountId, message: (err as Error)?.message?.slice(0, 160) })
    // 5xx: il provider ritenterà la consegna (gli eventi sono idempotenti).
    return json({ error: 'internal_error' }, 500)
  }
}

export const config = { path: '/api/webhooks/resend/:accountId' }
