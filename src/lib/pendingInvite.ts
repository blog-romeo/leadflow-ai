/**
 * Token di un invito in attesa durante registrazione/login (stesso browser).
 * Conservato solo finché l'invito non viene aperto: /join lo legge e lo cancella.
 * Il token è monouso, scade in 7 giorni e funziona solo con l'email invitata.
 */
const KEY = 'lf-pending-invite'
const TOKEN_RE = /^[0-9a-f]{48}$/

export function tokenFromHash(hash: string): string | null {
  const t = new URLSearchParams(hash.replace(/^#/, '')).get('t')
  return t && TOKEN_RE.test(t) ? t : null
}

export function savePendingInvite(token: string): void {
  if (!TOKEN_RE.test(token)) return
  try {
    localStorage.setItem(KEY, token)
  } catch {
    /* storage non disponibile */
  }
}

export function pendingInvite(): string | null {
  try {
    const t = localStorage.getItem(KEY)
    return t && TOKEN_RE.test(t) ? t : null
  } catch {
    return null
  }
}

export function clearPendingInvite(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* storage non disponibile */
  }
}
