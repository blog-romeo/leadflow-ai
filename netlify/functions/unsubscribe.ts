import { verifyUnsubscribeToken } from './_shared/campaigns/crypto'
import { campaignDeps } from './_shared/campaigns/deps'
import { log } from './_shared/log'

/**
 * GET/POST /api/unsubscribe?t=<token> — disiscrizione dalle email.
 * - POST (anche "one-click" dei client di posta, RFC 8058): registra subito l'opposizione.
 * - GET: pagina di conferma con un pulsante (i link possono essere aperti da scanner automatici,
 *   quindi la registrazione avviene solo con POST).
 * Nessun login richiesto; il token contiene solo l'id del messaggio firmato con HMAC.
 */
const page = (title: string, body: string, form = '') => `<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;background:#f6f7f9;color:#1b1f24;margin:0;display:grid;min-height:100vh;place-items:center;padding:16px}main{background:#fff;max-width:440px;padding:28px;border-radius:12px;border:1px solid #e3e6ea}h1{font-size:20px;margin:0 0 8px}p{line-height:1.5;color:#3d444d}button{margin-top:12px;font:inherit;padding:10px 16px;border-radius:8px;border:0;background:#1b4dd8;color:#fff;cursor:pointer}</style></head>
<body><main><h1>${title}</h1><p>${body}</p>${form}</main></body></html>`

const html = (s: string, status = 200) => new Response(s, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } })

export default async (req: Request): Promise<Response> => {
  const url = new URL(req.url)
  const token = url.searchParams.get('t') ?? ''
  const messageId = verifyUnsubscribeToken(token)
  if (!messageId) return html(page('Link non valido', 'Il link di disiscrizione non è valido o è incompleto. Puoi rispondere all’email chiedendo di non essere più contattato.'), 400)

  if (req.method === 'GET') {
    const action = `/api/unsubscribe?t=${encodeURIComponent(token)}`
    return html(page('Non ricevere più email', 'Conferma per non ricevere più comunicazioni commerciali da questo mittente.', `<form method="post" action="${action}"><button type="submit">Conferma disiscrizione</button></form>`))
  }
  if (req.method !== 'POST') return html(page('Metodo non consentito', ''), 405)
  try {
    await campaignDeps().store.registerUnsubscribe(messageId)
    log('info', 'unsubscribe.registered', { message_id: messageId })
    return html(page('Disiscrizione registrata', 'Non riceverai altre email commerciali da questo mittente. La richiesta è stata registrata.'))
  } catch (err) {
    log('error', 'unsubscribe.failed', { message: (err as Error)?.message?.slice(0, 160) })
    return html(page('Si è verificato un errore', 'Non siamo riusciti a registrare la richiesta. Riprova tra qualche minuto oppure rispondi all’email chiedendo la disiscrizione.'), 500)
  }
}

export const config = { path: '/api/unsubscribe' }
