import { fetchWithTimeout } from '../fetchTimeout'

/**
 * Notifiche interne alla piattaforma (nuova richiesta demo, avvisi critici) via Resend.
 * Attive SOLO se configurate con variabili d'ambiente dedicate della piattaforma, distinte
 * dagli account email delle organizzazioni (Campaign Manager):
 *   PLATFORM_NOTIFY_RESEND_API_KEY, PLATFORM_NOTIFY_FROM (mittente su dominio verificato),
 *   PLATFORM_NOTIFY_TO (destinatari interni, separati da virgola).
 * Se mancano, nulla viene inviato e l'esito "not_configured" viene registrato: le richieste
 * restano comunque consultabili nella console super admin.
 * Sono messaggi operativi interni, non comunicazioni commerciali.
 */
export type NotifyResult = { sent: true } | { sent: false; reason: 'not_configured' | 'provider_error' | 'timeout' }

export function notifyConfig(env: Record<string, string | undefined> = process.env) {
  const apiKey = env.PLATFORM_NOTIFY_RESEND_API_KEY?.trim()
  const from = env.PLATFORM_NOTIFY_FROM?.trim()
  const to = (env.PLATFORM_NOTIFY_TO ?? '').split(',').map((s) => s.trim()).filter((s) => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(s)).slice(0, 5)
  if (!apiKey || !from || to.length === 0) return null
  return { apiKey, from, to }
}

export async function notifyPlatform(subject: string, textBody: string, fetchImpl?: typeof fetch): Promise<NotifyResult> {
  const cfg = notifyConfig()
  if (!cfg) return { sent: false, reason: 'not_configured' }
  return sendVia(cfg.apiKey, cfg.from, cfg.to, subject, textBody, fetchImpl)
}

/**
 * Email transazionale della piattaforma a UN destinatario (es. invito di un collaboratore).
 * Usa la stessa chiave e lo stesso mittente delle notifiche interne; richiede solo
 * PLATFORM_NOTIFY_RESEND_API_KEY e PLATFORM_NOTIFY_FROM. Senza, non invia nulla.
 */
export async function sendPlatformEmail(to: string, subject: string, textBody: string, env: Record<string, string | undefined> = process.env, fetchImpl?: typeof fetch): Promise<NotifyResult> {
  const apiKey = env.PLATFORM_NOTIFY_RESEND_API_KEY?.trim()
  const from = env.PLATFORM_NOTIFY_FROM?.trim()
  if (!apiKey || !from) return { sent: false, reason: 'not_configured' }
  if (!/^[^@\s<>"']+@[^@\s<>"']+\.[a-z]{2,}$/i.test(to)) return { sent: false, reason: 'provider_error' }
  return sendVia(apiKey, from, [to], subject.replace(/[\r\n]+/g, ' '), textBody, fetchImpl)
}

async function sendVia(apiKey: string, from: string, to: string[], subject: string, textBody: string, fetchImpl?: typeof fetch): Promise<NotifyResult> {
  const cfg = { apiKey, from, to }
  try {
    const res = await fetchWithTimeout(
      'https://api.resend.com/emails',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({ from: cfg.from, to: cfg.to, subject: subject.slice(0, 180), text: textBody.slice(0, 8000) }),
      },
      8_000,
      fetchImpl,
    )
    return res.ok ? { sent: true } : { sent: false, reason: 'provider_error' }
  } catch {
    return { sent: false, reason: 'timeout' }
  }
}
