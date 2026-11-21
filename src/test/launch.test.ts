import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { robotsTxt, sitemapXml, siteUrl, type PublicRoutes } from '../../scripts/generate-seo.mjs'
import { it as itDict } from '../i18n/it'
import { en } from '../i18n/en'
import { PUBLIC_FEATURES } from '../config/features'
import { LEGAL_DOCS } from '../content/legal'
import { validateDemoClient } from '../features/demo/validate'
import { anonymousId, getConsent, setConsent, track } from '../lib/analytics'

const root = process.cwd()
const routes = JSON.parse(readFileSync(resolve(root, 'seo/public-routes.json'), 'utf8')) as PublicRoutes

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })
}

describe('SEO tecnico', () => {
  it('robots.txt: aree private escluse e sitemap indicata', () => {
    const txt = robotsTxt(routes, 'https://leadflow.example')
    for (const p of ['/app', '/super-admin', '/reseller', '/onboarding', '/api', '/login']) expect(txt).toContain(`Disallow: ${p}`)
    expect(txt).toContain('Sitemap: https://leadflow.example/sitemap.xml')
  })
  it('Deploy Preview: tutto bloccato', () => {
    expect(robotsTxt(routes, 'https://x.netlify.app', false)).toBe('User-agent: *\nDisallow: /\n')
  })
  it('sitemap: solo pagine pubbliche reali, nessuna area privata né bozza legale', () => {
    const xml = sitemapXml(routes, 'https://leadflow.example', '2026-11-20')
    expect(xml).toContain('<loc>https://leadflow.example/</loc>')
    expect(xml).toContain('<loc>https://leadflow.example/prezzi</loc>')
    expect(/\/app|\/super-admin|\/legal|\/login/.test(xml)).toBe(false)
    expect((xml.match(/<url>/g) ?? []).length).toBe(routes.indexable.length)
  })
  it('URL del sito validato', () => {
    expect(siteUrl({ SITE_URL: 'https://leadflow.example/' })).toBe('https://leadflow.example')
    expect(siteUrl({ URL: 'javascript:alert(1)' })).toBe('')
  })
  it('lo script inline di index.html non è stato toccato e i meta OG usano il segnaposto', () => {
    const html = readFileSync(resolve(root, 'index.html'), 'utf8')
    expect(html).toContain('og:image" content="__SITE_URL__/og-image.png"')
    expect(html.match(/<script>/g)?.length).toBe(1)
  })
})

describe('nessun segreto nel codice del browser', () => {
  const files = walk(resolve(root, 'src')).filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f))
  it('nessuna chiave server o segreto nel frontend', () => {
    // Valori di segreti (non i nomi delle variabili, citati nelle guide di configurazione) e letture di env server.
    const SECRET_VALUE = /sk_(live|test)_[A-Za-z0-9]{8,}|rk_(live|test)_[A-Za-z0-9]{8,}|whsec_[A-Za-z0-9]{8,}|re_[A-Za-z0-9]{16,}|eyJhbGciOi[A-Za-z0-9_-]{10,}|sk-[A-Za-z0-9]{20,}/
    const SERVER_ENV = /process\.env\.|import\.meta\.env\.(SUPABASE_SERVICE_ROLE_KEY|STRIPE_SECRET_KEY|OPENAI_API_KEY)/
    const offenders = files.filter((f) => {
      const src = readFileSync(f, 'utf8')
      return SECRET_VALUE.test(src) || SERVER_ENV.test(src)
    })
    expect(offenders).toEqual([])
  })
  it('il frontend non importa codice delle functions', () => {
    const offenders = files.filter((f) => /from ['"][./]*netlify\/functions/.test(readFileSync(f, 'utf8')))
    expect(offenders).toEqual([])
  })
  it('solo variabili VITE_ pubbliche nel frontend', () => {
    const names = new Set(files.flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/import\.meta\.env\.([A-Z_]+)/g)].map((m) => m[1])))
    // VITE_FEATURE_AI_AGENTS (Prompt 8): booleano pubblico di sola visibilità del menu, non un segreto.
    for (const n of names) expect(['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY', 'VITE_APP_URL', 'VITE_RELEASE', 'VITE_FEATURE_AI_AGENTS', 'DEV', 'PROD', 'MODE']).toContain(n)
  })
})

describe('contenuti pubblici onesti', () => {
  const pub = JSON.stringify([itDict.landing2, itDict.pricing, itDict.faq, itDict.demo, en.landing2, en.pricing, en.faq, en.demo]).toLowerCase()
  it('nessuna promessa di risultati, recensioni, clienti o certificazioni inventate', () => {
    for (const bad of ['clienti garantiti', 'risultati garantiti', 'vendite garantite', 'guaranteed results', 'guaranteed customers', 'certificat', 'iso 27001', 'recension', 'testimonial', 'customer reviews', 'stelle', 'stars', 'partner ufficiale', 'official partner', 'trusted by', 'scelto da', 'aziende ci hanno scelto']) {
      expect(pub.includes(bad)).toBe(false)
    }
  })
  it('titolo e sottotitolo richiesti', () => {
    expect(itDict.landing2.heroTitle).toBe('Trova nuove opportunità commerciali con l’intelligenza artificiale.')
    expect(itDict.landing2.heroSubtitle).toBe(
      'LeadFlow AI aiuta le aziende a individuare potenziali clienti B2B, analizzare opportunità e organizzare il processo di vendita da un’unica piattaforma.',
    )
    expect(itDict.landing2.ctaStart).toBe('Inizia ora')
    expect(itDict.landing2.ctaDemo).toBe('Richiedi una demo')
  })
  it('FAQ: 7 domande con risposta', () => {
    const items = itDict.faq.items as Record<string, string>
    for (let i = 1; i <= 7; i++) expect(items[`q${i}`] && items[`a${i}`]).toBeTruthy()
  })
  it('funzioni dipendenti da servizi esterni non dichiarate "operative"', () => {
    for (const f of PUBLIC_FEATURES) if (f.dependsOn.length > 0) expect(f.status).not.toBe('operational')
  })
  it('bozze legali con segnaposto riconoscibili', () => {
    for (const doc of Object.values(LEGAL_DOCS)) expect(JSON.stringify(doc)).toContain('[DA COMPLETARE')
  })
})

describe('richiesta demo (validazione nel browser)', () => {
  const ok = { name: 'Laura Bianchi', company: 'Bianchi Srl', email: 'laura@bianchi.it', phone: '', sector: 'Logistica', message: 'Vorremmo una demo del Lead Finder.', contact_preference: 'email' }
  it('valida', () => expect(validateDemoClient(ok, true)).toEqual({}))
  it('consenso e telefono richiesti', () => {
    expect(validateDemoClient({ ...ok, contact_preference: 'phone' }, false)).toEqual({ phone: 'required', consent: 'required' })
  })
})

describe('statistiche solo con consenso', () => {
  const g = globalThis as unknown as Record<string, unknown>
  const calls: unknown[] = []
  // In jsdom (vitest) si usa il localStorage reale; nel runner Node se ne crea uno in memoria.
  if (typeof window === 'undefined') {
    const mem = new Map<string, string>()
    g.window = { localStorage: { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) } }
  }
  const store = () => (g.window as { localStorage: Storage }).localStorage
  const prevFetch = g.fetch
  function reset() {
    store().removeItem('lf-consent-analytics')
    store().removeItem('lf-anon-id')
    calls.length = 0
    g.fetch = (url: string, init: { body: string }) => {
      calls.push([url, JSON.parse(init.body)])
      return Promise.resolve(new Response('{}'))
    }
  }
  it('senza scelta: nessun id e nessuna chiamata', () => {
    reset()
    expect(getConsent()).toBeNull()
    expect(anonymousId()).toBeNull()
    track('landing_visit', '/x1')
    expect(calls).toHaveLength(0)
  })
  it('rifiuto: nessuna chiamata', () => {
    reset()
    setConsent('denied')
    track('landing_visit', '/x2')
    expect(calls).toHaveLength(0)
  })
  it('consenso: id casuale anonimo, evento inviato una volta per pagina', () => {
    reset()
    setConsent('granted')
    track('pricing_viewed', '/x3')
    track('pricing_viewed', '/x3')
    expect(calls).toHaveLength(1)
    const [url, body] = calls[0] as [string, { anonymous_id: string; consent: boolean; event: string }]
    expect(url).toBe('/api/events')
    expect(body.anonymous_id).toMatch(/^[0-9a-f]{32}$/)
    expect(body).toMatchObject({ consent: true, event: 'pricing_viewed' })
  })
  it('revoca: id cancellato', () => {
    reset()
    setConsent('granted')
    anonymousId()
    setConsent('denied')
    expect(store().getItem('lf-anon-id')).toBeNull()
    g.fetch = prevFetch
  })
})
