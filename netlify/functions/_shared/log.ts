/**
 * Logging strutturato senza dati sensibili.
 * Le chiavi che possono contenere segreti o dati personali vengono sempre oscurate.
 */
const SENSITIVE = /(key|token|secret|authorization|password|email|phone|cookie|contact|name|website|address|input|output|body)/i

export function redact(value: unknown, depth = 0): unknown {
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
  const line = JSON.stringify({ level, event, time: new Date().toISOString(), ...(redact(fields) as object) })
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.info(line)
}
