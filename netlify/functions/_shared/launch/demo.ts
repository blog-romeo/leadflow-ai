/**
 * Validazione delle richieste di demo dal sito pubblico. Funzione pura (testabile).
 * Antispam: campo esca (honeypot) nascosto, tempo minimo di compilazione, limite di frequenza
 * per IP (applicato dall'endpoint, con hash HMAC: l'IP non viene salvato) e rifiuto dei
 * link e del markup nei campi brevi. Le email personali (gmail, ecc.) sono ammesse ma
 * segnalate: il modulo chiede un'email professionale senza bloccare chi non ne ha una.
 */
export const EMPLOYEE_RANGES = ['1-9', '10-49', '50-249', '250+'] as const
export const CONTACT_PREFERENCES = ['email', 'phone', 'video_call'] as const
export const MIN_FILL_MS = 3_000
export const MAX_FILL_MS = 24 * 3_600_000

const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.it', 'hotmail.com', 'hotmail.it', 'outlook.com', 'outlook.it', 'live.com', 'live.it',
  'icloud.com', 'me.com', 'libero.it', 'virgilio.it', 'tiscali.it', 'alice.it', 'tim.it', 'fastwebnet.it', 'email.it', 'proton.me', 'protonmail.com',
])
const EMAIL_RE = /^[^@\s<>"']{1,64}@[^@\s<>"']+\.[a-z]{2,}$/i
const PHONE_RE = /^\+?[0-9 ()./-]{6,25}$/
const MARKUP_OR_LINK = /[<>]|https?:\/\/|www\./i

export interface DemoInput {
  name: string
  company: string
  email: string
  phone: string | null
  sector: string
  employees: (typeof EMPLOYEE_RANGES)[number] | null
  message: string
  contact_preference: (typeof CONTACT_PREFERENCES)[number]
  locale: 'it' | 'en'
}

export type DemoValidation =
  | { ok: true; data: DemoInput; personalEmail: boolean }
  | { ok: false; spam: true }
  | { ok: false; spam: false; errors: Record<string, string> }

function text(v: unknown): string {
  return typeof v === 'string' ? v.normalize('NFC').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim() : ''
}

export function isPersonalEmail(email: string): boolean {
  return FREE_EMAIL_DOMAINS.has(email.split('@')[1]?.toLowerCase() ?? '')
}

export function validateDemo(raw: unknown, now = Date.now()): DemoValidation {
  const b = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>
  // Honeypot: un campo invisibile agli utenti. Se compilato, è un bot. Risposta "silenziosa".
  if (text(b.website_url) !== '') return { ok: false, spam: true }
  const started = typeof b.started_at === 'number' ? b.started_at : NaN
  if (!Number.isFinite(started) || now - started < MIN_FILL_MS || now - started > MAX_FILL_MS) return { ok: false, spam: true }

  const errors: Record<string, string> = {}
  const name = text(b.name)
  const company = text(b.company)
  const email = text(b.email).toLowerCase()
  const phone = text(b.phone) || null
  const sector = text(b.sector)
  const message = text(b.message)
  const employees = b.employees === undefined || b.employees === null || b.employees === '' ? null : text(b.employees)
  const pref = text(b.contact_preference)
  const locale = b.locale === 'en' ? 'en' : 'it'

  if (name.length < 2 || name.length > 120 || MARKUP_OR_LINK.test(name)) errors.name = 'invalid'
  if (company.length < 2 || company.length > 160 || MARKUP_OR_LINK.test(company)) errors.company = 'invalid'
  if (!EMAIL_RE.test(email) || email.length > 254) errors.email = 'invalid'
  if (sector.length < 2 || sector.length > 120 || MARKUP_OR_LINK.test(sector)) errors.sector = 'invalid'
  if (message.length < 10) errors.message = 'too_short'
  else if (message.length > 2000) errors.message = 'too_long'
  else if ((message.match(/https?:\/\//gi) ?? []).length > 2) errors.message = 'too_many_links'
  if (employees !== null && !(EMPLOYEE_RANGES as readonly string[]).includes(employees)) errors.employees = 'invalid'
  if (!(CONTACT_PREFERENCES as readonly string[]).includes(pref)) errors.contact_preference = 'invalid'
  if (phone !== null && !PHONE_RE.test(phone)) errors.phone = 'invalid'
  if (pref === 'phone' && phone === null) errors.phone = 'required'
  if (b.consent !== true) errors.consent = 'required'

  if (Object.keys(errors).length > 0) return { ok: false, spam: false, errors }
  return {
    ok: true,
    personalEmail: isPersonalEmail(email),
    data: {
      name, company, email, phone, sector, message, locale,
      employees: employees as DemoInput['employees'],
      contact_preference: pref as DemoInput['contact_preference'],
    },
  }
}
