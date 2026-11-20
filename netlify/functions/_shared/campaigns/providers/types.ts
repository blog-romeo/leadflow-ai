/**
 * Interfaccia comune dei provider email autorizzati.
 * Ogni provider dichiara se è implementato e come si autentica; le credenziali
 * arrivano sempre dal server (decifrate al momento dell'uso) e non lasciano le functions.
 */
export type ProviderErrorKind = 'auth' | 'transient' | 'permanent' | 'idempotency_conflict' | 'not_found'

export class ProviderError extends Error {
  constructor(
    public kind: ProviderErrorKind,
    public code: string,
    public status?: number,
  ) {
    super(code)
  }
}

export interface DnsRecord {
  record: string
  name: string
  type: string
  value: string
  status: string
  ttl?: string
  priority?: number
}

export interface DomainInfo {
  id: string
  name: string
  status: string
  records: DnsRecord[]
}

export interface OutgoingEmail {
  from: string
  to: string
  subject: string
  text: string
  html: string
  replyTo?: string | null
  headers: Record<string, string>
  tags: { name: string; value: string }[]
}

export interface NormalizedEvent {
  type: string
  providerMessageId: string | null
  occurredAt: string
  detail: Record<string, unknown>
  received?: { emailId: string; from: string; to: string[]; subject: string | null; messageId: string | null }
}

export interface ReceivedEmail {
  id: string
  from: string
  subject: string | null
  text: string | null
  html: string | null
  headers: Record<string, string>
  receivedAt: string
}

export interface EmailProvider {
  id: 'resend' | 'gmail' | 'microsoft365'
  label: string
  implemented: boolean
  auth: 'api_key' | 'oauth'
  docsUrl: string
  notes: string
  createOrGetDomain(apiKey: string, domain: string): Promise<DomainInfo>
  getDomain(apiKey: string, id: string): Promise<DomainInfo>
  requestVerification(apiKey: string, id: string): Promise<void>
  send(apiKey: string, email: OutgoingEmail, idempotencyKey: string): Promise<{ id: string }>
  normalizeWebhook(payload: unknown): NormalizedEvent | null
  getReceived(apiKey: string, id: string): Promise<ReceivedEmail>
}
