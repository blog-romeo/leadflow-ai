/**
 * Verifiche lato server sull'output del modello, indipendenti dal prompt:
 * • email: mai inventate → rimosse dal testo
 * • URL, telefoni e importi: ammessi solo se presenti nei dati (profilo, lead, listino)
 * • promesse non verificabili (garanzie, percentuali di risultato) → segnalate
 * • fatti citati: verificati sul contesto, altrimenti marcati come non verificati
 */
export interface Warning {
  code:
    | 'email_removed'
    | 'unverified_url'
    | 'unverified_phone'
    | 'unverified_amount'
    | 'unverifiable_promise'
    | 'unverified_fact'
    | 'too_long'
    | 'legal_basis_check_required'
    | 'check_opposition_registry'
    | 'whatsapp_opt_in_required'
    | 'no_commercial_terms'
    | 'untrusted_content_filtered'
    | 'invented_testimonial'
    | 'artificial_urgency'
    | 'implied_relationship'
    | 'unknown_placeholder'
  detail?: string
}

export interface Allowed {
  urls: string[]
  phones: string[]
  amounts: number[]
}

const EMAIL_RE = /[\w.+-]+@[\w-]+(\.[\w-]+)+/g
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"')\]]+/gi
const PHONE_RE = /(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?){2,4}\d{2,4}/g
const AMOUNT_RE = /(?:€|eur(?:o|os)?\b|usd|\$|chf|£)\s?(\d{1,3}(?:[.\s]\d{3})*(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)|(\d{1,3}(?:[.\s]\d{3})*(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)\s?(?:€|eur(?:o|os)?\b|usd|\$|chf|£)/gi
const PROMISE_RE = /\b(garantit[oaie]|garantiamo|garanzia di risultat\w*|guarantee[ds]?|guaranteed|risultati certi|sicuramente (aumenter|raddoppier)\w*|raddoppi\w*|triplic\w*|double your|triple your|\d{2,3}\s?% (in più|di (aumento|crescita|vendite|prenotazioni)|more))/gi

const digits = (s: string) => s.replace(/\D/g, '')

export function parseAmount(raw: string): number | null {
  let s = raw.replace(/\s/g, '')
  if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.')
  else if (/\.\d{3}($|\D)/.test(s)) s = s.replace(/\./g, '')
  else s = s.replace(/,/g, '')
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

function hostOf(u: string): string | null {
  try {
    return new URL(u.startsWith('http') ? u : `https://${u}`).hostname.replace(/^www\./, '').toLowerCase()
  } catch {
    return null
  }
}

export function checkText(text: string, allowed: Allowed, maxLength?: number): { text: string; warnings: Warning[] } {
  const warnings: Warning[] = []
  let out = text
  if (EMAIL_RE.test(out)) {
    out = out.replace(EMAIL_RE, '[email]')
    warnings.push({ code: 'email_removed' })
  }
  EMAIL_RE.lastIndex = 0

  const allowedHosts = new Set(allowed.urls.map(hostOf).filter((h): h is string => !!h))
  for (const m of out.match(URL_RE) ?? []) {
    const h = hostOf(m.replace(/[.,;:!?]+$/, ''))
    if (!h || !allowedHosts.has(h)) warnings.push({ code: 'unverified_url', detail: m.slice(0, 120) })
  }

  const allowedPhones = new Set(allowed.phones.map(digits).filter((d) => d.length >= 6))
  for (const m of out.match(PHONE_RE) ?? []) {
    const d = digits(m)
    if (d.length < 8 || d.length > 15) continue
    if (/^(19|20)\d{2}$/.test(d.slice(0, 4)) && d.length === 8) continue // date tipo 20261120
    if (![...allowedPhones].some((p) => p.endsWith(d.slice(-8)) || d.endsWith(p.slice(-8)))) warnings.push({ code: 'unverified_phone', detail: m.trim() })
  }

  const allowedAmounts = new Set(allowed.amounts.map((a) => Math.round(a * 100)))
  AMOUNT_RE.lastIndex = 0
  for (const m of out.matchAll(AMOUNT_RE)) {
    const n = parseAmount(m[1] ?? m[2] ?? '')
    if (n !== null && !allowedAmounts.has(Math.round(n * 100))) warnings.push({ code: 'unverified_amount', detail: m[0].trim() })
  }

  for (const m of out.match(PROMISE_RE) ?? []) warnings.push({ code: 'unverifiable_promise', detail: m })
  if (maxLength && out.length > maxLength) warnings.push({ code: 'too_long', detail: String(out.length) })
  return { text: out, warnings }
}

const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9€%]+/g, ' ')
    .trim()

/**
 * Un fatto è considerato supportato se compare nel contesto o se almeno il 70%
 * delle sue parole significative è presente nei dati forniti al modello.
 */
export function factSupported(fact: string, contextText: string): boolean {
  const f = norm(fact)
  if (!f) return false
  const ctx = norm(contextText)
  if (ctx.includes(f)) return true
  const words = f.split(' ').filter((w) => w.length > 3)
  if (words.length === 0) return false
  const ctxWords = new Set(ctx.split(' '))
  const hit = words.filter((w) => ctxWords.has(w)).length
  return hit / words.length >= 0.7
}

export function dedupeWarnings(ws: Warning[]): Warning[] {
  const seen = new Set<string>()
  return ws.filter((w) => {
    const k = `${w.code}|${w.detail ?? ''}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

// ── Controlli specifici per i modelli di campagna ─────────────────────────
const TESTIMONIAL_RE = /\b(i nostri clienti (dicono|affermano)|come (ci ha detto|racconta) [A-Z]|recension\w+ a 5 stelle|testimonianz\w+|our (clients|customers) say|five-star review|testimonial)/gi
const URGENCY_RE = /\b(solo (oggi|per pochi giorni|fino a)|ultimi posti|ultim[ae] disponibilit\w*|offerta (scade|limitata|valida fino)|scade (oggi|domani|il)|affrettat\w*|non perdere|last chance|limited time|expires (today|soon)|act now|only today)\b/gi
const RELATIONSHIP_RE = /\b(come (d'accordo|d’accordo|concordato|promesso|discusso)|facendo seguito alla nostra (telefonata|conversazione|chiacchierata)|come ci siamo detti|ci eravamo sentiti|as (discussed|agreed|promised)|following (up on )?our (call|conversation)|great (talking|speaking) (to|with) you)\b/gi
const PLACEHOLDER_RE = /\{\{\s*([^}]*)\s*\}\}/g
const ALLOWED_PH = new Set(['azienda', 'citta', 'settore', 'nome', 'company_name', 'city', 'industry', 'first_name'])

export function campaignChecks(text: string): Warning[] {
  const w: Warning[] = []
  for (const m of text.match(TESTIMONIAL_RE) ?? []) w.push({ code: 'invented_testimonial', detail: m })
  for (const m of text.match(URGENCY_RE) ?? []) w.push({ code: 'artificial_urgency', detail: m })
  for (const m of text.match(RELATIONSHIP_RE) ?? []) w.push({ code: 'implied_relationship', detail: m })
  for (const m of text.matchAll(PLACEHOLDER_RE)) if (!ALLOWED_PH.has((m[1] ?? '').trim())) w.push({ code: 'unknown_placeholder', detail: m[0] })
  return w
}
