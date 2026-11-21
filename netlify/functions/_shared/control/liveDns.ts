import { Resolver } from 'node:dns/promises'
import { safeFetchText } from '../lead-finder/analysis/ssrf'
import type { DnsDeps } from './domains'

/**
 * Dipendenze reali per la verifica dei domini: DNS pubblico con timeout e richiesta HTTPS
 * attraverso il fetch anti-SSRF (indirizzi privati/riservati bloccati al momento della connessione).
 */
export function liveDnsDeps(): DnsDeps {
  const resolver = new Resolver({ timeout: 3000, tries: 2 })
  return {
    resolveTxt: (name) => resolver.resolveTxt(name),
    resolveCname: (name) => resolver.resolveCname(name),
    async fetchHealth(host) {
      const res = await safeFetchText(`https://${host}/api/health`, { timeoutMs: 6000, maxBytes: 10_000, accept: /^application\/json/i, userAgent: 'LeadFlowAI-DomainCheck/1.0' })
      if (res.status !== 200 || !res.url.startsWith(`https://${host}/`)) return null
      try {
        return JSON.parse(res.body) as unknown
      } catch {
        return null
      }
    },
  }
}
