import { log } from '../log'
import { decryptSecret } from './crypto'
import type { EmailProvider } from './providers/types'
import type { CampaignStore } from './store'
import { verifySvix } from './svix'

/**
 * Webhook dei provider: firma verificata con il segreto dell'account (cifrato a riposo),
 * protezione da replay (timestamp), idempotenza per id evento. Le risposte in arrivo non
 * vengono elaborate qui: si accoda un job (il contenuto si legge via API del provider).
 */
export async function handleProviderWebhook(
  deps: { store: CampaignStore; providers: Record<EmailProvider['id'], EmailProvider>; env?: NodeJS.ProcessEnv; nowMs?: number },
  accountId: string,
  rawBody: string,
  headers: Headers,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { store } = deps
  const account = await store.getAccount(null, accountId)
  // Stessa risposta per account inesistente o revocato: nessuna enumerazione.
  if (!account || account.status === 'revoked') return { status: 404, body: { error: 'not_found' } }
  const secrets = await store.getAccountSecrets(accountId)
  if (!secrets?.webhook_secret_ciphertext) return { status: 401, body: { error: 'webhook_not_configured' } }
  const secret = decryptSecret(secrets.webhook_secret_ciphertext, `webhook:${accountId}`, deps.env)
  const check = verifySvix(rawBody, headers, secret, deps.nowMs)
  if (!check.ok) {
    log('warn', 'webhook.rejected', { account_id: accountId, reason: check.reason })
    return { status: 401, body: { error: 'invalid_signature' } }
  }
  let payload: unknown
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return { status: 400, body: { error: 'invalid_json' } }
  }
  const ev = deps.providers[account.provider].normalizeWebhook(payload)
  if (!account.webhook_configured) await store.setAccountStatus(accountId, { webhook_configured: true })
  if (!ev) return { status: 200, body: { ok: true, ignored: true } }

  if (ev.received) {
    await store.enqueueJob({
      org: account.organization_id,
      kind: 'ingest_inbound',
      key: `in:${account.id}:${ev.received.emailId}`,
      payload: { account_id: account.id, email_id: ev.received.emailId },
      maxAttempts: 6,
    })
    return { status: 200, body: { ok: true, queued: true } }
  }
  if (ev.providerMessageId) {
    await store.applyDeliveryEvent(account.id, check.id, ev.type, ev.providerMessageId, ev.occurredAt, ev.detail)
  }
  return { status: 200, body: { ok: true } }
}
