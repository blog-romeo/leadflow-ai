import { createResendProvider } from './resend'
import { ProviderError, type EmailProvider } from './types'

/**
 * Registro dei provider. Gmail e Microsoft 365 (OAuth) sono previsti dall'architettura
 * ma NON implementati: richiedono un'app OAuth registrata e verificata presso Google/Microsoft
 * (gli scope di invio sono "sensibili"). Sono mostrati come "non disponibili".
 */
function notImplemented(id: 'gmail' | 'microsoft365', label: string, docsUrl: string): EmailProvider {
  const no = async (): Promise<never> => {
    throw new ProviderError('permanent', 'provider_not_implemented')
  }
  return {
    id,
    label,
    implemented: false,
    auth: 'oauth',
    docsUrl,
    notes: 'Richiede un\'app OAuth verificata dal fornitore. Non configurato in questa versione.',
    createOrGetDomain: no,
    getDomain: no,
    requestVerification: no,
    send: no,
    normalizeWebhook: () => null,
    getReceived: no,
  }
}

export function providerRegistry(fetchImpl?: typeof fetch): Record<EmailProvider['id'], EmailProvider> {
  return {
    resend: createResendProvider(fetchImpl),
    gmail: notImplemented('gmail', 'Gmail / Google Workspace (OAuth)', 'https://developers.google.com/gmail/api'),
    microsoft365: notImplemented('microsoft365', 'Microsoft 365 / Outlook (OAuth)', 'https://learn.microsoft.com/graph/api/user-sendmail'),
  }
}
