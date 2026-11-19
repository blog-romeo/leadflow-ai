/** Normalizzazione dei dati aziendali: testo pulito, URL sicuri, telefoni, chiavi di confronto. */

export function cleanText(value: unknown, max = 300): string | null {
  if (typeof value !== 'string') return null
  // eslint-disable-next-line no-control-regex
  const v = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  return v ? v.slice(0, max) : null
}

/** Accetta solo URL http(s) validi, senza credenziali; rimuove frammenti e parametri di tracciamento. */
export function normalizeWebsite(value: unknown): string | null {
  const raw = cleanText(value, 500)
  if (!raw) return null
  const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return null
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
  if (!url.hostname.includes('.')) return null
  url.hash = ''
  for (const p of [...url.searchParams.keys()]) {
    if (/^(utm_|fbclid|gclid|mc_)/i.test(p)) url.searchParams.delete(p)
  }
  url.hostname = url.hostname.toLowerCase()
  return url.toString().replace(/\/$/, '')
}

export function normalizePhone(value: unknown): string | null {
  const raw = cleanText(value, 60)
  if (!raw) return null
  const first = raw.split(/[;,]/)[0]?.trim() ?? ''
  const cleaned = first.replace(/[^\d+()\s.-]/g, '').trim()
  const digits = cleaned.replace(/\D/g, '')
  return digits.length >= 6 && digits.length <= 16 ? cleaned : null
}

export function normalizeCountry(value: unknown): string | null {
  const v = cleanText(value, 10)?.toUpperCase() ?? null
  return v && /^[A-Z]{2}$/.test(v) ? v : null
}

/** Minuscole, senza accenti né punteggiatura: per confronti tra testi. */
export function fold(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

export function tokens(value: string | null | undefined): string[] {
  return value ? fold(value).split(' ').filter((t) => t.length > 1) : []
}

export function websiteDomain(website: string | null): string | null {
  if (!website) return null
  try {
    return new URL(website).hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}

/**
 * Chiave di deduplicazione tra fonti diverse: dominio del sito se presente,
 * altrimenti nome + città normalizzati. Null se i dati non bastano.
 */
export function dedupKey(input: { website: string | null; companyName: string | null; city: string | null }): string | null {
  const domain = websiteDomain(input.website)
  if (domain) return domain
  if (input.companyName && input.city) return `${fold(input.companyName)}|${fold(input.city)}`
  return null
}
