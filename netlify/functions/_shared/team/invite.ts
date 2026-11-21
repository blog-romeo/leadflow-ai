import { HttpError } from '../http'

/**
 * Creazione di un invito e invio (facoltativo) dell'email. Funzione pura con dipendenze iniettate.
 * - L'invito è creato dalla RPC org_create_invitation con il JWT dell'admin (ruolo, limite del
 *   piano, audit e hash del token sono applicati dal database).
 * - Il link usa il frammento "#t=": il token non arriva nei log dei server né nell'header Referer.
 * - Senza provider email configurato l'invito resta valido e il link viene restituito all'admin
 *   per una consegna manuale: l'email NON viene dichiarata inviata.
 */
export type EmailStatus = 'sent' | 'not_configured' | 'failed'

export interface InviteDeps {
  appUrl: string
  create: (email: string, role: 'member' | 'organization_admin') => Promise<{ id: string; token: string; expires_at: string; email: string; role: string }>
  context: () => Promise<{ organizationName: string; inviterName: string | null }>
  send: (to: string, subject: string, text: string) => Promise<{ sent: true } | { sent: false; reason: string }>
  markEmail: (id: string, error: string | null) => Promise<void>
}

export function inviteUrl(appUrl: string, token: string): string {
  if (!/^[0-9a-f]{48}$/.test(token)) throw new HttpError(500, 'invalid_token_format')
  return `${appUrl.replace(/\/+$/, '')}/join#t=${token}`
}

export function inviteEmail(locale: 'it' | 'en', p: { organizationName: string; inviterName: string | null; url: string; expiresAt: string }) {
  const org = p.organizationName.replace(/[\r\n]+/g, ' ').slice(0, 120)
  const who = (p.inviterName ?? '').replace(/[\r\n]+/g, ' ').slice(0, 80)
  const date = new Date(p.expiresAt).toLocaleDateString(locale === 'en' ? 'en-GB' : 'it-IT', { timeZone: 'Europe/Rome' })
  if (locale === 'en')
    return {
      subject: `Invitation to join ${org} on LeadFlow AI`,
      text: `${who ? `${who} has invited you` : 'You have been invited'} to join ${org} on LeadFlow AI.\n\nAccept the invitation (valid until ${date}):\n${p.url}\n\nSign in or create an account with this email address. If you were not expecting this invitation, ignore this message.`,
    }
  return {
    subject: `Invito a collaborare con ${org} su LeadFlow AI`,
    text: `${who ? `${who} ti ha invitato` : 'Sei stato invitato'} a collaborare con ${org} su LeadFlow AI.\n\nAccetta l'invito (valido fino al ${date}):\n${p.url}\n\nAccedi o crea un account con questo indirizzo email. Se non aspettavi questo invito, ignora il messaggio.`,
  }
}

export async function createInvite(deps: InviteDeps, input: { email: unknown; role: unknown; locale: unknown }) {
  if (typeof input.email !== 'string' || input.email.length > 254) throw new HttpError(400, 'invalid_email')
  const role = input.role === 'organization_admin' ? 'organization_admin' : input.role === 'member' || input.role === undefined ? 'member' : null
  if (!role) throw new HttpError(400, 'invalid_role')
  const locale = input.locale === 'en' ? 'en' : 'it'
  const inv = await deps.create(input.email, role)
  const url = inviteUrl(deps.appUrl, inv.token)
  const ctx = await deps.context()
  const mail = inviteEmail(locale, { organizationName: ctx.organizationName, inviterName: ctx.inviterName, url, expiresAt: inv.expires_at })
  const r = await deps.send(inv.email, mail.subject, mail.text)
  const status: EmailStatus = r.sent ? 'sent' : r.reason === 'not_configured' ? 'not_configured' : 'failed'
  await deps.markEmail(inv.id, r.sent ? null : r.reason)
  return {
    id: inv.id,
    email: inv.email,
    role: inv.role,
    expires_at: inv.expires_at,
    email_status: status,
    // Il link è mostrato all'admin solo se l'email non è partita, per la consegna manuale.
    ...(status === 'sent' ? {} : { invite_url: url }),
  }
}
