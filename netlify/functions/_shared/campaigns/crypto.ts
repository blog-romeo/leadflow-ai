import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { HttpError } from '../http'

/**
 * Cifratura delle credenziali dei provider (API key, segreti dei webhook).
 *
 * AES-256-GCM con chiave da LEADFLOW_CREDENTIALS_KEY (32 byte in base64), solo lato server.
 * Il testo cifrato è salvato in una tabella senza privilegi per i client; un dump del
 * database senza la chiave non espone le credenziali. Formato: v1.<iv>.<tag>.<ct> (base64url).
 * La chiave per i link di disiscrizione è derivata dalla stessa chiave (separazione per scopo).
 */
const VERSION = 'v1'

export function credentialsKeyStatus(env: NodeJS.ProcessEnv = process.env): 'ok' | 'missing' | 'invalid' {
  const raw = env.LEADFLOW_CREDENTIALS_KEY
  if (!raw) return 'missing'
  try {
    return Buffer.from(raw, 'base64').length === 32 ? 'ok' : 'invalid'
  } catch {
    return 'invalid'
  }
}

function masterKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  if (credentialsKeyStatus(env) !== 'ok') throw new HttpError(503, 'credentials_key_not_configured')
  return Buffer.from(env.LEADFLOW_CREDENTIALS_KEY!, 'base64')
}

function subKey(purpose: string, env?: NodeJS.ProcessEnv): Buffer {
  return createHmac('sha256', masterKey(env)).update(`leadflow:${purpose}`).digest()
}

export function encryptSecret(plain: string, aad: string, env?: NodeJS.ProcessEnv): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', subKey('credentials', env), iv)
  cipher.setAAD(Buffer.from(aad))
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return [VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.')
}

/** `aad` lega il segreto al suo account: un testo cifrato copiato su un altro account non si decifra. */
export function decryptSecret(token: string, aad: string, env?: NodeJS.ProcessEnv): string {
  const [v, iv, tag, ct] = token.split('.')
  if (v !== VERSION || !iv || !tag || !ct) throw new HttpError(500, 'credentials_corrupted')
  try {
    const d = createDecipheriv('aes-256-gcm', subKey('credentials', env), Buffer.from(iv, 'base64url'))
    d.setAAD(Buffer.from(aad))
    d.setAuthTag(Buffer.from(tag, 'base64url'))
    return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8')
  } catch {
    throw new HttpError(500, 'credentials_corrupted')
  }
}

/** Token di disiscrizione: id del messaggio + HMAC (nessun dato personale nel link). */
export function unsubscribeToken(messageId: string, env?: NodeJS.ProcessEnv): string {
  const mac = createHmac('sha256', subKey('unsubscribe', env)).update(messageId).digest('base64url').slice(0, 32)
  return `${Buffer.from(messageId).toString('base64url')}.${mac}`
}

export function verifyUnsubscribeToken(token: string, env?: NodeJS.ProcessEnv): string | null {
  const [idPart, mac] = token.split('.')
  if (!idPart || !mac || mac.length !== 32) return null
  let id: string
  try {
    id = Buffer.from(idPart, 'base64url').toString('utf8')
  } catch {
    return null
  }
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null
  const expected = createHmac('sha256', subKey('unsubscribe', env)).update(id).digest('base64url').slice(0, 32)
  // Confronto sui byte: un MAC con caratteri non ASCII ha più byte che caratteri (eccezione → 500).
  const a = Buffer.from(mac, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b) ? id : null
}

/** Ultime 4 cifre per mostrare quale chiave è configurata, senza esporla. */
export const maskKey = (k: string) => (k.length > 8 ? `…${k.slice(-4)}` : '…')
