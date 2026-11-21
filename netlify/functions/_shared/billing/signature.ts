import { createHmac, timingSafeEqual } from 'node:crypto'
import type { StripeEvent } from './stripeClient'

/**
 * Verifica della firma dei webhook Stripe (header Stripe-Signature, schema v1):
 *   signed_payload = `${t}.${raw_body}`  →  HMAC-SHA256 con il signing secret (whsec_...)
 * Il confronto è a tempo costante e il timestamp deve rientrare nella tolleranza
 * (default 300 s) per bloccare i replay. Va usato il body GREZZO, non il JSON riserializzato.
 */
export class SignatureError extends Error {
  constructor(public code: 'missing_signature' | 'malformed_signature' | 'timestamp_out_of_tolerance' | 'signature_mismatch' | 'invalid_payload') {
    super(code)
  }
}

export const DEFAULT_TOLERANCE_SECONDS = 300

export function computeSignature(payload: string, secret: string, timestamp: number): string {
  return createHmac('sha256', secret).update(`${timestamp}.${payload}`, 'utf8').digest('hex')
}

/** Header firmato come lo invierebbe Stripe (usato nei test e negli strumenti locali). */
export function signPayload(payload: string, secret: string, timestamp = Math.floor(Date.now() / 1000)): string {
  return `t=${timestamp},v1=${computeSignature(payload, secret, timestamp)}`
}

export function verifyStripeSignature(
  rawBody: string,
  header: string | null,
  secret: string,
  opts: { toleranceSeconds?: number; nowSeconds?: number } = {},
): StripeEvent {
  if (!header) throw new SignatureError('missing_signature')
  let timestamp: number | null = null
  const signatures: string[] = []
  for (const part of header.split(',')) {
    const idx = part.indexOf('=')
    if (idx <= 0) continue
    const k = part.slice(0, idx).trim()
    const v = part.slice(idx + 1).trim()
    if (k === 't' && /^\d{1,12}$/.test(v)) timestamp = Number(v)
    else if (k === 'v1' && /^[0-9a-f]{64}$/i.test(v)) signatures.push(v.toLowerCase())
  }
  if (timestamp === null || signatures.length === 0) throw new SignatureError('malformed_signature')

  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000)
  const tolerance = opts.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS
  if (Math.abs(now - timestamp) > tolerance) throw new SignatureError('timestamp_out_of_tolerance')

  const expected = Buffer.from(computeSignature(rawBody, secret, timestamp), 'hex')
  const ok = signatures.some((s) => {
    const got = Buffer.from(s, 'hex')
    return got.length === expected.length && timingSafeEqual(got, expected)
  })
  if (!ok) throw new SignatureError('signature_mismatch')

  let event: StripeEvent
  try {
    event = JSON.parse(rawBody) as StripeEvent
  } catch {
    throw new SignatureError('invalid_payload')
  }
  if (!event || event.object !== 'event' || typeof event.id !== 'string' || !/^evt_[A-Za-z0-9]+$/.test(event.id) || typeof event.type !== 'string') {
    throw new SignatureError('invalid_payload')
  }
  return event
}
