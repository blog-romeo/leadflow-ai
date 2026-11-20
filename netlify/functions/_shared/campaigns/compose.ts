import { unsubscribeToken } from './crypto'
import type { OutgoingEmail } from './providers/types'

/**
 * Composizione finale dell'email: testo approvato + firma + piè di pagina obbligatorio
 * (identità del mittente, origine dei dati / motivo del contatto, informativa privacy,
 * disiscrizione). Header List-Unsubscribe con disiscrizione one-click (RFC 8058).
 * Solo testo semplice convertito in HTML con escape: nessun pixel, nessun link tracciato.
 */
export interface SenderIdentity {
  legalName: string
  address: string
  privacyUrl: string
  signature: string | null
}

export interface ComposeInput {
  messageId: string
  kind: 'campaign' | 'reply' | 'test'
  fromName: string
  fromEmail: string
  replyTo: string | null
  to: string
  subject: string
  body: string
  language: 'it' | 'en'
  basis: string | null
  sourceName: string | null
  sender: SenderIdentity
  appUrl: string
  campaignId?: string | null
}

const T = {
  it: {
    because: {
      consent: 'Ricevi questa email perché hai acconsentito a essere contattato da',
      soft_opt_in: 'Ricevi questa email in quanto cliente di',
      legitimate_interest: 'Ti contattiamo all’indirizzo professionale pubblicato',
      reply: 'Rispondiamo al tuo messaggio.',
      test: 'Email di prova inviata da LeadFlow AI.',
    },
    source: 'Origine dei dati',
    privacy: 'Informativa privacy',
    unsubscribe: 'Per non ricevere più email da noi',
  },
  en: {
    because: {
      consent: 'You are receiving this email because you agreed to be contacted by',
      soft_opt_in: 'You are receiving this email as a customer of',
      legitimate_interest: 'We are contacting you at the business address published',
      reply: 'We are replying to your message.',
      test: 'Test email sent from LeadFlow AI.',
    },
    source: 'Data source',
    privacy: 'Privacy notice',
    unsubscribe: 'To stop receiving emails from us',
  },
}

function reason(i: ComposeInput): string {
  const t = T[i.language].because
  if (i.kind === 'test') return t.test
  if (i.kind === 'reply') return t.reply
  if (i.basis === 'consent') return `${t.consent} ${i.sender.legalName}.`
  if (i.basis === 'soft_opt_in') return `${t.soft_opt_in} ${i.sender.legalName}.`
  return `${t.legitimate_interest}${i.sourceName ? ` (${T[i.language].source}: ${i.sourceName})` : ''}.`
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
// Le intestazioni non possono contenere a capo (header injection).
const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ').trim()

export function composeEmail(i: ComposeInput, env?: NodeJS.ProcessEnv): OutgoingEmail {
  const token = unsubscribeToken(i.messageId, env)
  const unsubUrl = `${i.appUrl.replace(/\/$/, '')}/api/unsubscribe?t=${encodeURIComponent(token)}`
  const l = T[i.language]
  const footer = [
    '—',
    i.sender.signature?.trim() || i.fromName,
    '',
    `${i.sender.legalName} · ${i.sender.address}`,
    reason(i),
    `${l.privacy}: ${i.sender.privacyUrl}`,
    `${l.unsubscribe}: ${unsubUrl}`,
  ].join('\n')
  const text = `${i.body.trim()}\n\n${footer}`
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#1a1a1a">${escapeHtml(i.body.trim()).replace(/\n/g, '<br>')}<br><br><div style="font-size:12px;color:#555">${escapeHtml(footer)
    .replace(/\n/g, '<br>')
    .replace(escapeHtml(unsubUrl), `<a href="${escapeHtml(unsubUrl)}">${escapeHtml(unsubUrl)}</a>`)
    .replace(escapeHtml(i.sender.privacyUrl), `<a href="${escapeHtml(i.sender.privacyUrl)}">${escapeHtml(i.sender.privacyUrl)}</a>`)}</div></div>`
  return {
    from: `${oneLine(i.fromName).replace(/[<>"]/g, '')} <${i.fromEmail}>`,
    to: i.to,
    subject: oneLine(i.subject).slice(0, 200),
    text,
    html,
    replyTo: i.replyTo,
    headers: {
      'List-Unsubscribe': `<${unsubUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
    tags: [
      { name: 'kind', value: i.kind },
      ...(i.campaignId ? [{ name: 'campaign', value: i.campaignId.replace(/-/g, '_') }] : []),
    ],
  }
}
