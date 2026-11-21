import { json } from './_shared/http'
import { log } from './_shared/log'
import { readStripeConfig } from './_shared/billing/config'
import { SignatureError, verifyStripeSignature } from './_shared/billing/signature'
import { processWebhookEvent } from './_shared/billing/service'
import { billingDeps } from './_shared/billing/deps'

/**
 * POST /.netlify/functions/stripe-webhook — endpoint dei webhook Stripe.
 *
 * 1. Legge il body GREZZO (req.text()) e verifica la firma Stripe-Signature con
 *    STRIPE_WEBHOOK_SECRET (HMAC-SHA256, tolleranza 5 minuti, confronto a tempo costante).
 * 2. Idempotenza per event.id (tabella stripe_webhook_events): i duplicati rispondono 200.
 * 3. Lo stato viene riletto da Stripe (fonte autorevole): gli eventi fuori ordine non
 *    possono riportare indietro un abbonamento.
 * 4. Errori temporanei → 500, così Stripe ritenta; nessun dettaglio interno nella risposta.
 *
 * Non dichiara config.path: resta raggiungibile al percorso standard /.netlify/functions/stripe-webhook.
 */
const MAX_BODY = 1_000_000

export default async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { allow: 'POST' })
  const { config, state } = readStripeConfig()
  if (!config || !config.webhookSecret) {
    log('error', 'stripe_webhook.not_configured', { missing: state.missing, blocked: state.blocked, webhook: state.webhook_configured })
    return json({ error: 'billing_not_configured' }, 503)
  }
  const len = Number(req.headers.get('content-length') ?? '0')
  if (len > MAX_BODY) return json({ error: 'payload_too_large' }, 413)
  const raw = await req.text()
  if (raw.length > MAX_BODY) return json({ error: 'payload_too_large' }, 413)

  let event
  try {
    event = verifyStripeSignature(raw, req.headers.get('stripe-signature'), config.webhookSecret)
  } catch (err) {
    const code = err instanceof SignatureError ? err.code : 'invalid_signature'
    log('warn', 'stripe_webhook.rejected', { code })
    return json({ error: 'invalid_signature' }, 400)
  }

  try {
    const outcome = await processWebhookEvent(billingDeps(), event)
    return json({ received: true, status: outcome.status }, outcome.http)
  } catch (err) {
    log('error', 'stripe_webhook.unhandled', { event_id: event.id, message: (err as Error)?.message?.slice(0, 120) })
    return json({ error: 'internal_error' }, 500)
  }
}
