import { checkDomain, DomainError, normalizeHostname, type DnsDeps } from '../domains'
import { decodeBase64, detectType, ImageError, validateImage } from '../images'
import { assetUrl, requestHostname, toPublicBranding } from '../tenant'
import { rpcHttpError } from '../rpc'

// ─── Immagini di test costruite byte per byte (nessun file esterno) ─────────
function png(width: number, height: number, extra = 64): Uint8Array {
  const b = new Uint8Array(33 + extra)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  const dv = new DataView(b.buffer)
  dv.setUint32(16, width)
  dv.setUint32(20, height)
  return b
}
function jpeg(width: number, height: number): Uint8Array {
  // SOI, APP0 (len 16), SOF0 (len 17)
  const b = new Uint8Array(2 + 18 + 19 + 4)
  b.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
  const o = 2 + 18
  b.set([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff], o)
  return b
}
function webpVp8x(width: number, height: number): Uint8Array {
  const b = new Uint8Array(40)
  b.set([...'RIFF'].map((c) => c.charCodeAt(0)), 0)
  b.set([...'WEBP'].map((c) => c.charCodeAt(0)), 8)
  b.set([...'VP8X'].map((c) => c.charCodeAt(0)), 12)
  const w = width - 1
  const h = height - 1
  b.set([w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff], 24)
  b.set([h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff], 27)
  return b
}
function ico(size: number): Uint8Array {
  const b = new Uint8Array(40)
  b.set([0, 0, 1, 0, 1, 0, size === 256 ? 0 : size, size === 256 ? 0 : size])
  return b
}
const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>')

describe('validazione immagini di branding', () => {
  it('riconosce il tipo dal contenuto e legge le dimensioni', () => {
    expect(validateImage(png(400, 120), 'image/png', 'logo')).toMatchObject({ type: 'png', width: 400, height: 120 })
    expect(validateImage(jpeg(800, 200), 'image/jpeg', 'login_logo')).toMatchObject({ type: 'jpg', width: 800, height: 200 })
    expect(validateImage(webpVp8x(300, 300), 'image/webp', 'logo')).toMatchObject({ type: 'webp', width: 300, height: 300 })
    expect(validateImage(ico(32), 'image/x-icon', 'favicon')).toMatchObject({ type: 'ico', width: 32, height: 32 })
  })
  it('SVG rifiutato (possibile XSS), anche se dichiarato come PNG', () => {
    expect(detectType(svg)).toBe(null)
    expect(() => validateImage(svg, 'image/png', 'logo')).toThrow(ImageError)
    expect(() => validateImage(svg, 'image/svg+xml', 'logo')).toThrow('unsupported_type')
  })
  it('MIME dichiarato diverso dal contenuto rifiutato', () => {
    expect(() => validateImage(png(100, 100), 'image/jpeg', 'logo')).toThrow('type_mismatch')
  })
  it('dimensioni e peso oltre i limiti rifiutati', () => {
    expect(() => validateImage(png(5000, 100), 'image/png', 'logo')).toThrow('bad_dimensions')
    expect(() => validateImage(png(8, 8), 'image/png', 'logo')).toThrow('bad_dimensions')
    expect(() => validateImage(png(100, 100, 600 * 1024), 'image/png', 'logo')).toThrow('too_large')
    expect(() => validateImage(png(1024, 1024), 'image/png', 'favicon')).toThrow('bad_dimensions')
  })
  it('favicon: JPEG non ammesso; ICO ammesso solo come favicon', () => {
    expect(() => validateImage(jpeg(64, 64), 'image/jpeg', 'favicon')).toThrow('unsupported_type')
    expect(() => validateImage(ico(32), 'image/x-icon', 'logo')).toThrow('unsupported_type')
  })
  it('PNG troncato o corrotto rifiutato', () => {
    const bad = png(100, 100).slice(0, 14)
    expect(() => validateImage(bad, 'image/png', 'logo')).toThrow('corrupt')
  })
  it('base64 rigoroso con limite prima della decodifica', () => {
    expect(decodeBase64('data:image/png;base64,iVBORw0KGgo=', 1000)).toHaveLength(8)
    expect(() => decodeBase64('iVBO<script>', 1000)).toThrow('corrupt')
    expect(() => decodeBase64('A'.repeat(4000), 1000)).toThrow('too_large')
  })
})

describe('domini personalizzati', () => {
  it('normalizza e valida l\'hostname', () => {
    expect(normalizeHostname('  App.Agenzia-Cliente.IT. ')).toBe('app.agenzia-cliente.it')
    for (const bad of ['agenzia.it', 'http://app.agenzia.it', 'app.agenzia.it/x', '10.0.0.1', 'app..agenzia.it', '-app.agenzia.it', 'àpp.agenzia.it', 'app.agenzia.i']) {
      expect(() => normalizeHostname(bad)).toThrow(DomainError)
    }
  })
  it('domini della piattaforma, di hosting condiviso o riservati non ammessi', () => {
    for (const bad of ['evil.leadflow.netlify.app', 'x.supabase.co', 'app.example.test', 'intranet.corp.local']) {
      expect(() => normalizeHostname(bad)).toThrow('domain_not_allowed')
    }
    expect(() => normalizeHostname('crm.leadflow.it', { platformHosts: ['leadflow.it'] })).toThrow('domain_not_allowed')
  })

  function deps(over: Partial<DnsDeps> = {}): DnsDeps & { healthCalls: string[] } {
    const healthCalls: string[] = []
    return {
      resolveTxt: async () => [['leadflow-verify=', 'abc123']],
      resolveCname: async () => ['LeadFlow.netlify.app.'],
      fetchHealth: async (h) => {
        healthCalls.push(h)
        return { status: 'ok', service: 'leadflow-ai' }
      },
      healthCalls,
      ...over,
    }
  }
  const base = { hostname: 'app.agenzia.it', token: 'abc123', cnameTarget: 'leadflow.netlify.app', provisioned: true }

  it('TXT (anche spezzato in più stringhe) + CNAME + HTTPS → tutto ok', async () => {
    expect(await checkDomain(base, deps())).toEqual({ txtOk: true, dnsStatus: 'ok', httpsStatus: 'active', error: null })
  })
  it('dominio non verificato: TXT assente o diverso', async () => {
    const enotfound = Object.assign(new Error('x'), { code: 'ENOTFOUND' })
    expect(await checkDomain(base, deps({ resolveTxt: async () => { throw enotfound } }))).toMatchObject({ txtOk: false, error: 'txt_not_found', httpsStatus: 'pending' })
    expect(await checkDomain(base, deps({ resolveTxt: async () => [['leadflow-verify=altro']] }))).toMatchObject({ txtOk: false, error: 'txt_value_mismatch' })
  })
  it('HTTPS non controllato finché il provisioning non è confermato (nessuna richiesta verso il dominio)', async () => {
    const d = deps()
    expect(await checkDomain({ ...base, provisioned: false }, d)).toMatchObject({ txtOk: true, dnsStatus: 'ok', httpsStatus: 'unknown' })
    expect(d.healthCalls).toHaveLength(0)
  })
  it('CNAME errato o destinazione non configurata', async () => {
    expect(await checkDomain(base, deps({ resolveCname: async () => ['altro-hosting.com'] }))).toMatchObject({ dnsStatus: 'misconfigured', error: 'cname_mismatch' })
    expect(await checkDomain({ ...base, cnameTarget: null }, deps())).toMatchObject({ dnsStatus: 'misconfigured', error: 'cname_target_not_configured' })
  })
  it('endpoint di salute non LeadFlow (dominio puntato altrove) → HTTPS in errore', async () => {
    expect(await checkDomain(base, deps({ fetchHealth: async () => ({ service: 'altro' }) }))).toMatchObject({ httpsStatus: 'error', error: 'https_not_ready' })
    expect(await checkDomain(base, deps({ fetchHealth: async () => { throw new Error('blocked_address') } }))).toMatchObject({ httpsStatus: 'error' })
  })
})

describe('risoluzione tenant e branding pubblico', () => {
  it('hostname dalla richiesta (non da parametri del client)', () => {
    expect(requestHostname(new Request('https://App.Agenzia.it/api/tenant?host=evil.it'))).toBe('app.agenzia.it')
  })
  it('solo campi pubblici, rivalidati: niente URL non https, markup o percorsi arbitrari', () => {
    const b = toPublicBranding('r1', {
      platform_name: 'Alfa <b>', primary_color: '#1D4ED8', secondary_color: 'red', theme: 'dark',
      privacy_url: 'javascript:alert(1)', terms_url: 'https://alfa.it/termini', support_email: 'help@alfa.test',
      logo_path: '11111111-1111-4111-8111-111111111111/logo-0123456789ab.png', favicon_path: '../../secret.png',
      updated_by: 'user-id', stripe_customer_id: 'cus_x',
    }, 'https://abc.supabase.co')
    expect(b).toEqual({
      reseller_id: 'r1', platform_name: null, logo_url: 'https://abc.supabase.co/storage/v1/object/public/branding/11111111-1111-4111-8111-111111111111/logo-0123456789ab.png',
      login_logo_url: null, favicon_url: null, primary_color: '#1d4ed8', secondary_color: null, theme: 'dark', welcome_title: null, welcome_text: null,
      support_email: 'help@alfa.test', privacy_url: null, terms_url: 'https://alfa.it/termini',
    })
    expect(assetUrl('http://insecure.example', '11111111-1111-4111-8111-111111111111/logo-0123456789ab.png')).toBe(null)
  })
})

describe('errori delle RPC → HTTP', () => {
  it('codici stabili senza messaggi interni', () => {
    expect(rpcHttpError('x', { code: '42501', message: 'permission denied for table organizations' })).toMatchObject({ status: 403, code: 'forbidden' })
    expect(rpcHttpError('x', { code: 'P0001', message: 'rate_limited', details: '{"retry_after":60}' })).toMatchObject({ status: 429, code: 'rate_limited', details: { retry_after: 60 } })
    expect(rpcHttpError('x', { code: 'P0001', message: 'reseller_client_limit_reached', details: '{"limit":25}' })).toMatchObject({ status: 409, code: 'reseller_client_limit_reached', details: { limit: 25 } })
    expect(rpcHttpError('x', { code: 'P0001', message: 'platform_ai_paused' })).toMatchObject({ status: 503 })
    expect(rpcHttpError('x', { code: '23514', message: 'new row violates check constraint "x"' })).toMatchObject({ status: 400, code: 'invalid_input' })
    expect(rpcHttpError('x', { code: 'P0002', message: 'invitation_not_found' })).toMatchObject({ status: 404, code: 'invitation_not_found' })
    expect(rpcHttpError('x', { code: 'XX000', message: 'internal detail' })).toMatchObject({ status: 500, code: 'storage_error' })
  })
})
