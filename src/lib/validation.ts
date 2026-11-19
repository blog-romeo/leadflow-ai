/** Validazioni condivise dai form. Il database applica gli stessi vincoli lato server. */

export type ValidationResult = { ok: true } | { ok: false; error: string }

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

export function validateEmail(value: string): ValidationResult {
  const v = value.trim()
  if (!v) return { ok: false, error: 'validation.emailRequired' }
  if (v.length > 254 || !EMAIL_RE.test(v)) return { ok: false, error: 'validation.emailInvalid' }
  return { ok: true }
}

export function validatePassword(value: string): ValidationResult {
  if (value.length < 10) return { ok: false, error: 'validation.passwordShort' }
  if (value.length > 128) return { ok: false, error: 'validation.passwordLong' }
  if (!/[A-Za-z]/.test(value) || !/\d/.test(value)) return { ok: false, error: 'validation.passwordWeak' }
  return { ok: true }
}

export function validateFullName(value: string): ValidationResult {
  const v = value.trim()
  if (v.length < 2) return { ok: false, error: 'validation.nameShort' }
  if (v.length > 120) return { ok: false, error: 'validation.nameLong' }
  return { ok: true }
}

export function validateOrganizationName(value: string): ValidationResult {
  const v = value.trim()
  if (v.length < 2) return { ok: false, error: 'validation.orgNameShort' }
  if (v.length > 120) return { ok: false, error: 'validation.orgNameLong' }
  return { ok: true }
}

/** Partita IVA: facoltativa. Se presente: 2 lettere paese opzionali + 8–15 caratteri alfanumerici. */
export function validateVatNumber(value: string): ValidationResult {
  const v = value.replace(/\s+/g, '').toUpperCase()
  if (!v) return { ok: true }
  if (!/^([A-Z]{2})?[0-9A-Z]{8,15}$/.test(v)) return { ok: false, error: 'validation.vatInvalid' }
  return { ok: true }
}

export function validateRetentionDays(value: number): ValidationResult {
  if (!Number.isInteger(value) || value < 30 || value > 3650) return { ok: false, error: 'validation.retentionRange' }
  return { ok: true }
}

export function normalizeVat(value: string): string | null {
  const v = value.replace(/\s+/g, '').toUpperCase()
  return v || null
}
