import { resolveTxt } from 'node:dns/promises'
import type { DnsRecord } from './providers/types'

/**
 * Controlli DNS indipendenti dal provider: SPF/DKIM risultano dai record richiesti dal
 * provider (stato "verified"), DMARC viene letto direttamente da _dmarc.<dominio>
 * perché il provider non lo configura.
 */
export type Resolver = (name: string) => Promise<string[][]>

export async function checkDmarc(domain: string, resolver: Resolver = resolveTxt): Promise<{ status: 'pass' | 'missing' | 'fail'; policy: string | null }> {
  const labels = domain.toLowerCase().split('.')
  // DMARC del dominio o, se assente, del dominio organizzativo (ultimi due livelli).
  const candidates = [domain, labels.slice(-2).join('.')].filter((d, i, a) => a.indexOf(d) === i)
  for (const d of candidates) {
    try {
      const txt = (await resolver(`_dmarc.${d}`)).map((parts) => parts.join(''))
      const rec = txt.find((t) => /^v=DMARC1\b/i.test(t.trim()))
      if (rec) {
        const p = /\bp=(none|quarantine|reject)\b/i.exec(rec)?.[1]?.toLowerCase() ?? null
        return { status: p ? 'pass' : 'fail', policy: p }
      }
    } catch {
      /* NXDOMAIN o timeout: si prova il candidato successivo */
    }
  }
  return { status: 'missing', policy: null }
}

export function recordStatus(records: DnsRecord[], kind: 'SPF' | 'DKIM'): 'pass' | 'missing' | 'fail' | 'unknown' {
  const rs = records.filter((r) => r.record.toUpperCase() === kind)
  if (rs.length === 0) return 'unknown'
  if (rs.every((r) => r.status === 'verified')) return 'pass'
  if (rs.some((r) => r.status === 'failed' || r.status === 'temporary_failure')) return 'fail'
  return 'missing'
}
