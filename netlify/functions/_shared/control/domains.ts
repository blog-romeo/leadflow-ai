import { isIP } from 'node:net'

/**
 * Domini personalizzati dei rivenditori.
 *
 * Proprietà: record TXT  _leadflow-challenge.<hostname>  =  leadflow-verify=<token>
 * Instradamento: record CNAME  <hostname>  →  destinazione configurata (es. leadflow.netlify.app)
 * HTTPS: GET https://<hostname>/api/health deve rispondere come LeadFlow AI (certificato valido,
 *        alias configurato sull'hosting). La richiesta passa dal fetch anti-SSRF.
 *
 * Il provisioning dell'alias sull'hosting NON è automatico: lo conferma il super admin.
 */
export const CHALLENGE_PREFIX = '_leadflow-challenge.'
export const CHALLENGE_VALUE_PREFIX = 'leadflow-verify='

const BLOCKED_SUFFIX = /(^|\.)(netlify\.app|netlify\.com|supabase\.co|stripe\.com|localhost|local|internal|example|test|invalid|onion)$/
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/

export class DomainError extends Error {
  constructor(public code: 'invalid_hostname' | 'domain_not_allowed') {
    super(code)
  }
}

/** Hostname normalizzato (minuscolo, senza punto finale). Solo sottodomini ASCII/punycode. */
export function normalizeHostname(raw: string, opts: { platformHosts?: string[] } = {}): string {
  const host = raw.trim().toLowerCase().replace(/\.$/, '')
  if (!host || host.length > 253 || /[^a-z0-9.-]/.test(host) || isIP(host)) throw new DomainError('invalid_hostname')
  const labels = host.split('.')
  if (labels.length < 3 || !labels.every((l) => LABEL.test(l)) || !/^[a-z]{2,63}$/.test(labels[labels.length - 1]!)) {
    // Almeno un sottodominio (es. app.agenzia.it): il dominio radice non può puntare con CNAME.
    throw new DomainError('invalid_hostname')
  }
  if (BLOCKED_SUFFIX.test(host)) throw new DomainError('domain_not_allowed')
  for (const p of opts.platformHosts ?? []) {
    const ph = p.toLowerCase()
    if (host === ph || host.endsWith(`.${ph}`)) throw new DomainError('domain_not_allowed')
  }
  return host
}

export interface DnsDeps {
  resolveTxt: (name: string) => Promise<string[][]>
  resolveCname: (name: string) => Promise<string[]>
  /** Corpo JSON di https://<host>/api/health, o null se non raggiungibile/valido. */
  fetchHealth: (host: string) => Promise<unknown>
}

export interface DomainCheckResult {
  txtOk: boolean
  dnsStatus: 'missing' | 'misconfigured' | 'ok'
  httpsStatus: 'unknown' | 'pending' | 'active' | 'error'
  error: string | null
}

const dnsCode = (err: unknown) => (err as { code?: string })?.code ?? 'dns_error'

export async function checkDomain(
  input: { hostname: string; token: string; cnameTarget: string | null; provisioned: boolean },
  deps: DnsDeps,
): Promise<DomainCheckResult> {
  let txtOk = false
  let error: string | null = null
  try {
    const records = await deps.resolveTxt(`${CHALLENGE_PREFIX}${input.hostname}`)
    txtOk = records.some((chunks) => chunks.join('') === `${CHALLENGE_VALUE_PREFIX}${input.token}`)
    if (!txtOk) error = 'txt_value_mismatch'
  } catch (err) {
    error = ['ENOTFOUND', 'ENODATA'].includes(dnsCode(err)) ? 'txt_not_found' : 'txt_lookup_failed'
  }

  let dnsStatus: DomainCheckResult['dnsStatus'] = 'missing'
  try {
    const cnames = (await deps.resolveCname(input.hostname)).map((c) => c.toLowerCase().replace(/\.$/, ''))
    if (!input.cnameTarget) {
      dnsStatus = 'misconfigured'
      error ??= 'cname_target_not_configured'
    } else if (cnames.includes(input.cnameTarget.toLowerCase())) {
      dnsStatus = 'ok'
    } else {
      dnsStatus = 'misconfigured'
      error ??= 'cname_mismatch'
    }
  } catch (err) {
    dnsStatus = 'missing'
    error ??= ['ENOTFOUND', 'ENODATA'].includes(dnsCode(err)) ? 'cname_not_found' : 'cname_lookup_failed'
  }

  // HTTPS si controlla solo quando l'alias è stato configurato sull'hosting e il DNS punta corretto.
  let httpsStatus: DomainCheckResult['httpsStatus'] = input.provisioned ? 'pending' : 'unknown'
  if (input.provisioned && dnsStatus === 'ok' && txtOk) {
    const body = await deps.fetchHealth(input.hostname).catch(() => null)
    const ok = !!body && typeof body === 'object' && (body as { service?: unknown }).service === 'leadflow-ai'
    httpsStatus = ok ? 'active' : 'error'
    if (!ok) error ??= 'https_not_ready'
  }
  return { txtOk, dnsStatus, httpsStatus, error }
}
