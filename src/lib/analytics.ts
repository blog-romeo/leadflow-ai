/**
 * Statistiche del sito pubblico, SOLO con consenso esplicito.
 * - Senza consenso: nessun id, nessuna chiamata di rete, nulla salvato oltre alla scelta stessa.
 * - Con consenso: un id casuale (128 bit, nessun dato personale) in localStorage e l'invio a
 *   /api/events di 3 eventi: landing_visit, pricing_viewed, signup_started.
 * - Global Privacy Control (navigator.globalPrivacyControl) equivale a un rifiuto.
 * Gli eventi degli utenti registrati (registrazione, onboarding, pagamento, attivazione)
 * sono generati dal database e non usano questo modulo. Deduplicazione: lato server per giorno.
 */
export type ConsentChoice = 'granted' | 'denied'
export type PublicEvent = 'landing_visit' | 'pricing_viewed' | 'signup_started'

const CONSENT_KEY = 'lf-consent-analytics'
const ID_KEY = 'lf-anon-id'
const CONSENT_VERSION = '1'
const listeners = new Set<() => void>()

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null
  } catch {
    return null
  }
}

export function gpcEnabled(): boolean {
  return typeof navigator !== 'undefined' && (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl === true
}

export function getConsent(): ConsentChoice | null {
  if (gpcEnabled()) return 'denied'
  const raw = storage()?.getItem(CONSENT_KEY)
  if (!raw) return null
  const [version, choice] = raw.split(':')
  return version === CONSENT_VERSION && (choice === 'granted' || choice === 'denied') ? choice : null
}

export function setConsent(choice: ConsentChoice): void {
  const s = storage()
  s?.setItem(CONSENT_KEY, `${CONSENT_VERSION}:${choice}`)
  // Revoca: l'id anonimo viene eliminato subito.
  if (choice === 'denied') s?.removeItem(ID_KEY)
  listeners.forEach((l) => l())
}

export function resetConsent(): void {
  storage()?.removeItem(CONSENT_KEY)
  storage()?.removeItem(ID_KEY)
  listeners.forEach((l) => l())
}

export function onConsentChange(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function randomId(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export function anonymousId(): string | null {
  if (getConsent() !== 'granted') return null
  const s = storage()
  let id = s?.getItem(ID_KEY) ?? null
  if (!id || !/^[0-9a-f]{32}$/.test(id)) {
    id = randomId()
    s?.setItem(ID_KEY, id)
  }
  return id
}

const sentThisPage = new Set<string>()

export function track(event: PublicEvent, page: string = typeof location !== 'undefined' ? location.pathname : '/'): void {
  const id = anonymousId()
  if (!id) return
  const key = `${event}:${page}`
  if (sentThisPage.has(key)) return
  sentThisPage.add(key)
  const body = JSON.stringify({ event, anonymous_id: id, page: page.slice(0, 60), consent: true })
  try {
    void fetch('/api/events', { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true }).catch(() => undefined)
  } catch {
    /* le statistiche non devono mai interrompere la navigazione */
  }
}
