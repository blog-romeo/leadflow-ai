import { lookup as dnsLookup } from 'node:dns'
import { isIP } from 'node:net'
import { Agent, fetch as undiciFetch } from 'undici'

/**
 * Fetch sicuro verso siti di terze parti (protezione SSRF).
 * • solo http/https sulle porte standard, niente credenziali nell'URL
 * • il DNS è risolto e verificato AL MOMENTO DELLA CONNESSIONE (no DNS rebinding):
 *   indirizzi privati, loopback, link-local, CGNAT, multicast e riservati sono bloccati
 * • redirect gestiti manualmente e riverificati (max 3), timeout e limite di dimensione
 */
export class SsrfError extends Error {
  constructor(public code: 'invalid_url' | 'blocked_address' | 'too_many_redirects' | 'too_large' | 'timeout' | 'http_error' | 'unsupported_content' | 'network_error') {
    super(code)
  }
}

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0
}
const V4_BLOCKS: [string, number][] = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]

export function isBlockedAddress(ip: string): boolean {
  const v = isIP(ip)
  if (v === 4) {
    const n = ipv4ToInt(ip)
    return V4_BLOCKS.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0
      return (n & mask) === (ipv4ToInt(base) & mask)
    })
  }
  if (v === 6) {
    const a = ip.toLowerCase()
    if (a === '::' || a === '::1') return true
    const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    if (mapped?.[1]) return isBlockedAddress(mapped[1])
    if (/^::ffff:/.test(a)) return true
    const first = parseInt(a.split(':')[0] || '0', 16)
    if ((first & 0xfe00) === 0xfc00) return true // fc00::/7 unique local
    if ((first & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
    if ((first & 0xff00) === 0xff00) return true // multicast
    if (a.startsWith('64:ff9b:') || a.startsWith('2001:db8:') || a.startsWith('2002:')) return true
    return false
  }
  return true
}

export function validatePublicUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new SsrfError('invalid_url')
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new SsrfError('invalid_url')
  if (url.username || url.password) throw new SsrfError('invalid_url')
  if (url.port && !['80', '443'].includes(url.port)) throw new SsrfError('invalid_url')
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (!host || host === 'localhost' || /\.(localhost|local|internal|lan|home|corp)$/.test(host)) throw new SsrfError('blocked_address')
  if (isIP(host) && isBlockedAddress(host)) throw new SsrfError('blocked_address')
  if (!isIP(host) && !host.includes('.')) throw new SsrfError('blocked_address')
  return url
}

type LookupCb = (err: NodeJS.ErrnoException | null, address?: string | { address: string; family: number }[], family?: number) => void

/** lookup usato dal socket: verifica ogni indirizzo risolto prima di connettersi. */
export function safeLookup(hostname: string, options: { all?: boolean } | number, cb: LookupCb): void {
  const all = typeof options === 'object' && options?.all
  dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
    if (err) return cb(err)
    const list = addresses as { address: string; family: number }[]
    if (!list.length || list.some((a) => isBlockedAddress(a.address))) {
      const e = new Error('blocked_address') as NodeJS.ErrnoException
      e.code = 'EBLOCKED'
      return cb(e)
    }
    if (all) cb(null, list)
    else cb(null, list[0]!.address, list[0]!.family)
  })
}

const agent = new Agent({ connect: { lookup: safeLookup as never, timeout: 5000 }, headersTimeout: 8000, bodyTimeout: 8000 })

export interface SafeFetchResult {
  url: string
  status: number
  contentType: string
  body: string
}

export async function safeFetchText(
  raw: string,
  opts: { timeoutMs?: number; maxBytes?: number; accept?: RegExp; userAgent?: string } = {},
): Promise<SafeFetchResult> {
  const timeoutMs = opts.timeoutMs ?? 8000
  const maxBytes = opts.maxBytes ?? 600_000
  const accept = opts.accept ?? /^(text\/html|application\/xhtml\+xml|text\/plain)/i
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let current = validatePublicUrl(raw)
  try {
    for (let hop = 0; hop <= 3; hop++) {
      let res
      try {
        res = await undiciFetch(current.toString(), {
          dispatcher: agent,
          redirect: 'manual',
          signal: controller.signal,
          headers: { 'user-agent': opts.userAgent ?? 'LeadFlowAI-Analyzer/0.2', accept: 'text/html,application/xhtml+xml,text/plain;q=0.8' },
        })
      } catch (err) {
        const cause = (err as { cause?: { code?: string; message?: string } })?.cause
        if ((err as Error)?.name === 'AbortError') throw new SsrfError('timeout')
        if (cause?.code === 'EBLOCKED' || cause?.message === 'blocked_address') throw new SsrfError('blocked_address')
        throw new SsrfError('network_error')
      }
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = res.headers.get('location')
        await res.body?.cancel()
        if (!loc) throw new SsrfError('http_error')
        current = validatePublicUrl(new URL(loc, current).toString())
        continue
      }
      const contentType = res.headers.get('content-type') ?? ''
      if (!res.ok) {
        await res.body?.cancel()
        return { url: current.toString(), status: res.status, contentType, body: '' }
      }
      if (!accept.test(contentType)) {
        await res.body?.cancel()
        throw new SsrfError('unsupported_content')
      }
      const declared = Number(res.headers.get('content-length') ?? '0')
      if (declared > maxBytes) {
        await res.body?.cancel()
        throw new SsrfError('too_large')
      }
      const reader = res.body?.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > maxBytes) {
            await reader.cancel()
            break // tronca: per l'analisi bastano i primi maxBytes
          }
          chunks.push(value)
        }
      }
      const body = new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks))
      return { url: current.toString(), status: res.status, contentType, body }
    }
    throw new SsrfError('too_many_redirects')
  } finally {
    clearTimeout(timer)
  }
}
