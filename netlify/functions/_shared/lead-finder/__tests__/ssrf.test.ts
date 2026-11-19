// @vitest-environment node
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isBlockedAddress, safeFetchText, safeLookup, validatePublicUrl } from '../analysis/ssrf'
import { isAllowedByRobots } from '../analysis/robots'
import { extractPage } from '../analysis/extract'

describe('Protezione SSRF', () => {
  it('blocca indirizzi privati, loopback, link-local, metadata cloud e IPv6 interni', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1']) {
      expect(isBlockedAddress(ip), ip).toBe(true)
    }
    for (const ip of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '2a00:1450:4001::200e']) expect(isBlockedAddress(ip), ip).toBe(false)
  })

  it('rifiuta schemi, credenziali, porte e host non pubblici', () => {
    for (const u of ['file:///etc/passwd', 'ftp://x.example', 'http://user:pw@x.example', 'http://x.example:8080', 'http://localhost', 'http://intranet', 'http://printer.local', 'http://[::1]/', 'http://169.254.169.254/latest/meta-data']) {
      expect(() => validatePublicUrl(u), u).toThrow()
    }
    expect(validatePublicUrl('https://www.example.com/path').hostname).toBe('www.example.com')
  })

  it('il resolver blocca nomi che risolvono su indirizzi interni (anti DNS rebinding)', async () => {
    const err = await new Promise<NodeJS.ErrnoException | null>((resolve) => safeLookup('localhost', { all: true }, (e) => resolve(e)))
    expect(err?.code).toBe('EBLOCKED')
  })

  describe('con un server locale reale', () => {
    let port = 0
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html>segreto interno</html>')
    })
    beforeAll(() => new Promise<void>((r) => server.listen(0, '127.0.0.1', () => ((port = (server.address() as AddressInfo).port), r()))))
    afterAll(() => new Promise<void>((r) => server.close(() => r())))

    it('non raggiunge servizi interni né direttamente né tramite IP', async () => {
      await expect(safeFetchText(`http://127.0.0.1:${port}/`)).rejects.toMatchObject({ code: 'invalid_url' }) // porta non standard
      await expect(safeFetchText('http://127.0.0.1/')).rejects.toMatchObject({ code: 'blocked_address' })
    })
  })
})

describe('robots.txt', () => {
  it('rispetta Disallow/Allow e il gruppo specifico del nostro user agent', () => {
    expect(isAllowedByRobots('User-agent: *\nDisallow: /', '/', 'LeadFlowAI-Analyzer')).toBe(false)
    expect(isAllowedByRobots('User-agent: *\nDisallow: /private', '/', 'LeadFlowAI-Analyzer')).toBe(true)
    expect(isAllowedByRobots('User-agent: *\nDisallow:', '/', 'LeadFlowAI-Analyzer')).toBe(true)
    expect(isAllowedByRobots('User-agent: leadflowai-analyzer\nDisallow: /\n\nUser-agent: *\nAllow: /', '/', 'LeadFlowAI-Analyzer')).toBe(false)
    expect(isAllowedByRobots('User-agent: *\nDisallow: /\nAllow: /$', '/', 'x')).toBe(true)
  })
})

describe('estrazione testo', () => {
  it('rimuove script, stili ed email; mantiene titolo e descrizione', () => {
    const p = extractPage('<html><head><title>Hotel &amp; Spa</title><meta name="description" content="Benvenuti"><script>alert(1)</script></head><body><style>x{}</style><h1>Camere</h1><p>Scrivi a info@hotel.example</p></body></html>')
    expect(p.title).toBe('Hotel & Spa')
    expect(p.description).toBe('Benvenuti')
    expect(p.text).toContain('Camere')
    expect(p.text).not.toContain('alert')
    expect(p.text).not.toContain('info@hotel.example')
  })
})
