/**
 * Segnalazione degli errori JavaScript del browser a /api/monitoring/client-error.
 * Inviati: nome dell'errore, messaggio e percorso della pagina (senza query string).
 * Il server rimuove email, ID, numeri e token prima di salvare. Massimo 5 segnalazioni
 * per pagina caricata; nessun dato del form, nessun contenuto della pagina.
 */
let sent = 0
const seen = new Set<string>()

export function reportClientError(code: string, message: string): void {
  if (sent >= 5) return
  const key = `${code}:${message.slice(0, 80)}`
  if (seen.has(key)) return
  seen.add(key)
  sent++
  const body = JSON.stringify({
    code: code.slice(0, 80),
    message: message.slice(0, 300),
    path: location.pathname,
    release: (import.meta.env.VITE_RELEASE as string | undefined) ?? null,
  })
  try {
    void fetch('/api/monitoring/client-error', { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true }).catch(() => undefined)
  } catch {
    /* mai bloccare l'app per il monitoraggio */
  }
}

export function installErrorReporting(): void {
  if (typeof window === 'undefined' || import.meta.env.DEV) return
  window.addEventListener('error', (e) => {
    // Errori di risorse esterne o script di estensioni: ignorati.
    if (!e.error || (e.filename && !e.filename.startsWith(location.origin))) return
    reportClientError((e.error as Error).name || 'Error', String((e.error as Error).message ?? e.message))
  })
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason as { name?: string; message?: string } | undefined
    if (r && typeof r === 'object' && 'code' in r) return // ApiError già gestiti dall'interfaccia
    reportClientError(r?.name || 'UnhandledRejection', String(r?.message ?? r ?? ''))
  })
}
