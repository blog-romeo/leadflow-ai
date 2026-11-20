import { randomUUID } from 'node:crypto'
import { HttpError } from '../http'
import { log } from '../log'
import { credentialsKeyStatus, decryptSecret, encryptSecret } from './crypto'
import { checkDmarc, recordStatus, type Resolver } from './dns'
import { ProviderError, type EmailProvider } from './providers/types'
import type { AccountsDb, CampaignStore } from './store'
import { sendMessage, type WorkerDeps } from './worker'

/**
 * Gestione degli account dei provider email (solo organization_admin, lato server).
 * - La API key viene verificata subito chiamando il provider e poi salvata cifrata.
 * - Lo stato "connected" si raggiunge solo con dominio mittente verificato dal provider.
 * - La revoca cancella le credenziali; le campagne collegate vengono sospese dal database.
 * - Nessuna modifica alla configurazione esterna oltre alla registrazione del dominio
 *   richiesta per la verifica (la chiave va revocata anche nel pannello del provider).
 */
export interface AccountDeps {
  accounts: AccountsDb
  store: CampaignStore
  providers: Record<EmailProvider['id'], EmailProvider>
  env?: NodeJS.ProcessEnv
  resolver?: Resolver
}

function requireCredentialsKey(env: NodeJS.ProcessEnv) {
  const s = credentialsKeyStatus(env)
  if (s !== 'ok') throw new HttpError(503, 'credentials_key_not_configured', { status: s })
}

function mapProviderError(err: unknown): never {
  if (err instanceof ProviderError) {
    if (err.kind === 'auth') throw new HttpError(400, 'provider_rejected_api_key')
    if (err.kind === 'transient') throw new HttpError(502, 'provider_unavailable')
    throw new HttpError(400, 'provider_error', { provider_code: err.code })
  }
  throw err
}

export async function connectAccount(
  deps: AccountDeps,
  ctx: { orgId: string; userId: string },
  input: { provider: 'resend' | 'gmail' | 'microsoft365'; label: string; from_name: string; from_email: string; reply_to?: string | null; api_key: string; daily_limit?: number },
) {
  const env = deps.env ?? process.env
  requireCredentialsKey(env)
  const provider = deps.providers[input.provider]
  if (!provider?.implemented || provider.auth !== 'api_key') throw new HttpError(400, 'provider_not_available')
  const domain = input.from_email.split('@')[1]!.toLowerCase()
  // 1. Verifica della chiave e registrazione/lettura del dominio mittente presso il provider.
  const info = await provider.createOrGetDomain(input.api_key, domain).catch(mapProviderError)
  // 2. Salvataggio: account + segreto cifrato legato all'id dell'account.
  const id = await deps.accounts.insertAccount({
    organization_id: ctx.orgId,
    provider: 'resend',
    label: input.label,
    from_name: input.from_name,
    from_email: input.from_email.toLowerCase(),
    reply_to: input.reply_to?.toLowerCase() ?? null,
    sending_domain: domain,
    daily_limit: input.daily_limit ?? 100,
    connected_by: ctx.userId,
  })
  await deps.accounts.upsertSecrets(id, ctx.orgId, { api_key_ciphertext: encryptSecret(input.api_key, `api_key:${id}`, env) })
  await deps.accounts.updateAccount(ctx.orgId, id, {
    provider_domain_id: info.id,
    domain_status: info.status,
    dns_records: info.records,
    spf_status: recordStatus(info.records, 'SPF'),
    dkim_status: recordStatus(info.records, 'DKIM'),
    last_checked_at: new Date().toISOString(),
  })
  log('info', 'communication.account_created', { account_id: id, provider: input.provider, domain_status: info.status })
  return refreshAccount(deps, ctx, id, { requestVerification: info.status !== 'verified', apiKey: input.api_key })
}

/** Rilegge lo stato del dominio (ed eventualmente chiede la verifica) e aggiorna lo stato dell'account. */
export async function refreshAccount(
  deps: AccountDeps,
  ctx: { orgId: string; userId: string },
  accountId: string,
  opts: { requestVerification?: boolean; apiKey?: string } = {},
) {
  const env = deps.env ?? process.env
  const acc = await deps.accounts.getAccountFull(ctx.orgId, accountId)
  if (!acc) throw new HttpError(404, 'account_not_found')
  if (acc.status === 'revoked') throw new HttpError(409, 'account_revoked')
  const provider = deps.providers[acc.provider]
  let apiKey = opts.apiKey
  if (!apiKey) {
    requireCredentialsKey(env)
    const secrets = await deps.store.getAccountSecrets(accountId)
    if (!secrets?.api_key_ciphertext) throw new HttpError(409, 'account_credentials_missing')
    apiKey = decryptSecret(secrets.api_key_ciphertext, `api_key:${accountId}`, env)
  }
  if (!acc.provider_domain_id) throw new HttpError(409, 'domain_not_registered')
  try {
    if (opts.requestVerification) await provider.requestVerification(apiKey, acc.provider_domain_id)
    const info = await provider.getDomain(apiKey, acc.provider_domain_id)
    const dmarc = await checkDmarc(acc.sending_domain, deps.resolver)
    const verified = info.status === 'verified'
    await deps.accounts.updateAccount(ctx.orgId, accountId, {
      domain_status: info.status,
      dns_records: info.records,
      spf_status: recordStatus(info.records, 'SPF'),
      dkim_status: recordStatus(info.records, 'DKIM'),
      dmarc_status: dmarc.status,
      dmarc_policy: dmarc.policy,
      status: verified ? 'connected' : 'pending',
      last_checked_at: new Date().toISOString(),
      last_error: null,
      ...(verified && acc.status !== 'connected' ? { connected_at: new Date().toISOString() } : {}),
    })
  } catch (err) {
    if (err instanceof ProviderError && err.kind === 'auth') {
      await deps.accounts.updateAccount(ctx.orgId, accountId, { status: 'error', last_error: 'API key rifiutata dal provider', last_checked_at: new Date().toISOString() })
      throw new HttpError(400, 'provider_rejected_api_key')
    }
    mapProviderError(err)
  }
  return deps.accounts.getAccountFull(ctx.orgId, accountId)
}

export async function setWebhookSecret(deps: AccountDeps, ctx: { orgId: string }, accountId: string, secret: string) {
  const env = deps.env ?? process.env
  requireCredentialsKey(env)
  const acc = await deps.accounts.getAccountFull(ctx.orgId, accountId)
  if (!acc || acc.status === 'revoked') throw new HttpError(404, 'account_not_found')
  if (!/^whsec_[A-Za-z0-9+/=]{16,}$/.test(secret)) throw new HttpError(400, 'invalid_webhook_secret')
  await deps.accounts.upsertSecrets(accountId, ctx.orgId, { webhook_secret_ciphertext: encryptSecret(secret, `webhook:${accountId}`, env) })
  // "configurato" diventa vero solo alla ricezione del primo evento con firma valida.
  await deps.accounts.updateAccount(ctx.orgId, accountId, { webhook_configured: false })
}

export async function revokeAccount(deps: AccountDeps, ctx: { orgId: string; userId: string }, accountId: string) {
  const acc = await deps.accounts.getAccountFull(ctx.orgId, accountId)
  if (!acc) throw new HttpError(404, 'account_not_found')
  await deps.accounts.deleteSecrets(accountId)
  await deps.accounts.updateAccount(ctx.orgId, accountId, { status: 'revoked', revoked_by: ctx.userId, revoked_at: new Date().toISOString(), webhook_configured: false })
  log('info', 'communication.account_revoked', { account_id: accountId })
}

const SANDBOX = /^(delivered|bounced|complained)(\+[a-z0-9_-]+)?@resend\.dev$/i

/**
 * Invio di prova autorizzato: solo verso indirizzi sandbox del provider o verso un membro
 * dell'organizzazione (controllo ripetuto anche dal database in begin_send).
 */
export async function testSend(
  deps: AccountDeps & { worker: Omit<WorkerDeps, 'store' | 'providers'> },
  ctx: { orgId: string; userId: string },
  input: { account_id: string; to: string; subject?: string; body?: string },
) {
  const to = input.to.trim().toLowerCase()
  const members = await deps.accounts.memberEmails(ctx.orgId)
  if (!SANDBOX.test(to) && !members.includes(to)) throw new HttpError(400, 'test_address_not_allowed')
  const acc = await deps.accounts.getAccountFull(ctx.orgId, input.account_id)
  if (!acc) throw new HttpError(404, 'account_not_found')
  if (acc.status !== 'connected') throw new HttpError(409, 'provider_not_connected')
  const { id } = await deps.store.createOutbound({
    org: ctx.orgId,
    kind: 'test',
    accountId: acc.id,
    leadId: null,
    inReplyTo: null,
    to,
    subject: input.subject?.trim() || 'Prova di invio LeadFlow AI',
    body: input.body?.trim() || 'Questa è un’email di prova inviata da LeadFlow AI per verificare la configurazione del provider.',
    idempotencyKey: `test:${randomUUID()}`,
    confirmedBy: ctx.userId,
  })
  const r = await sendMessage({ ...deps.worker, store: deps.store, providers: deps.providers }, { id: 'inline', attempts: 1, max_attempts: 1 }, id)
  if (r.outcome !== 'succeeded') throw new HttpError(502, 'test_send_failed', { reason: r.error })
  return { message_id: id }
}
