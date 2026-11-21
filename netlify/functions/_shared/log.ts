/**
 * Logging strutturato senza dati sensibili.
 * Le chiavi che possono contenere segreti o dati personali vengono sempre oscurate.
 */
const SENSITIVE = /(key|token|secret|authorization|password|email|phone|cookie|contact|name|website|address|input|output|body)/i

/**
 * Prompt 10: anche i VALORI vengono controllati. Un messaggio d'errore di una libreria può contenere una
 * chiave o un token (es. "Invalid API key sk-..."): questi schemi vengono sostituiti prima della scrittura.
 */
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}/g, // Stripe
  /\bwhsec_[A-Za-z0-9]{8,}/g, // segreto webhook Stripe
  /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{16,}/g, // OpenAI
  /\bre_[A-Za-z0-9]{16,}/g, // Resend
  /\bAIza[0-9A-Za-z_-]{30,}/g, // Google API key
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT (chiavi Supabase, sessioni)
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi,
  /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}/g, // token GitHub
]

export function redactString(v: string): string {
  let out = v
  for (const re of SECRET_VALUE_PATTERNS) out = out.replace(re, '[redacted-secret]')
  return out
}

export function redact(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactString(value)
  if (value === null || typeof value !== 'object' || depth > 4) return value
  if (Array.isArray(value)) return value.length > 20 ? `[${value.length} items]` : value.map((v) => redact(v, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE.test(k) ? '[redacted]' : redact(v, depth + 1)
  }
  return out
}

type Level = 'info' | 'warn' | 'error'
export function log(level: Level, event: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ level, event: redactString(event), time: new Date().toISOString(), ...(redact(fields) as object) })
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.info(line)
}
