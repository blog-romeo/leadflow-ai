import { describe, expect, it } from 'vitest'
import { validateDemo, MIN_FILL_MS } from '../demo'
import { rateKey } from '../hash'
import { integrationStatus } from '../integrations'
import { notifyConfig, notifyPlatform } from '../notify'
import { buildErrorRow, sanitizeMessage, sanitizePath } from '../../monitoring'

const NOW = 1_800_000_000_000
const valid = {
  name: 'Laura Bianchi', company: 'Bianchi Srl', email: 'Laura@Bianchi-Srl.it', sector: 'Logistica', employees: '10-49',
  message: 'Vorremmo capire come usare il Lead Finder.', contact_preference: 'email', consent: true, website_url: '', started_at: NOW - 20_000,
}

describe('richiesta demo: validazione e antispam', () => {
  it('accetta una richiesta valida e normalizza l’email', () => {
    const r = validateDemo(valid, NOW)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.email).toBe('laura@bianchi-srl.it')
      expect(r.personalEmail).toBe(false)
    }
  })
  it('honeypot compilato → spam silenzioso', () => {
    expect(validateDemo({ ...valid, website_url: 'http://spam.example' }, NOW)).toEqual({ ok: false, spam: true })
  })
  it('compilazione troppo rapida → spam', () => {
    expect(validateDemo({ ...valid, started_at: NOW - (MIN_FILL_MS - 1) }, NOW)).toEqual({ ok: false, spam: true })
    expect(validateDemo({ ...valid, started_at: undefined }, NOW)).toEqual({ ok: false, spam: true })
  })
  it('campi obbligatori, consenso e telefono richiesto per preferenza telefono', () => {
    const r = validateDemo({ ...valid, name: '', consent: false, contact_preference: 'phone', phone: '' }, NOW)
    expect(r).toMatchObject({ ok: false, spam: false, errors: { name: 'invalid', consent: 'required', phone: 'required' } })
  })
  it('rifiuta link e markup nei campi brevi', () => {
    expect(validateDemo({ ...valid, company: '<b>Acme</b>' }, NOW)).toMatchObject({ ok: false, errors: { company: 'invalid' } })
    expect(validateDemo({ ...valid, name: 'visit https://spam.example' }, NOW)).toMatchObject({ ok: false, errors: { name: 'invalid' } })
  })
  it('troppi link nel messaggio', () => {
    expect(validateDemo({ ...valid, message: 'a https://a.it b https://b.it c https://c.it' }, NOW)).toMatchObject({ ok: false, errors: { message: 'too_many_links' } })
  })
  it('email personale ammessa ma segnalata', () => {
    const r = validateDemo({ ...valid, email: 'laura@gmail.com' }, NOW)
    expect(r.ok && r.personalEmail).toBe(true)
  })
  it('valori non ammessi per dipendenti e preferenza', () => {
    expect(validateDemo({ ...valid, employees: '5000', contact_preference: 'fax' }, NOW)).toMatchObject({ ok: false, errors: { employees: 'invalid', contact_preference: 'invalid' } })
  })
})

describe('chiavi dei limiti di frequenza', () => {
  it('HMAC: nessun IP in chiaro, scopi separati, segreto obbligatorio', () => {
    const secret = 'x'.repeat(40)
    const a = rateKey('203.0.113.7', 'demo', secret)!
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(a.includes('203')).toBe(false)
    expect(rateKey('203.0.113.7', 'events', secret)).not.toBe(a)
    expect(rateKey('203.0.113.7', 'demo', 'corto')).toBeNull()
  })
})

describe('monitoraggio: sanificazione degli errori', () => {
  it('rimuove email, UUID, token, query string e numeri lunghi', () => {
    const s = sanitizeMessage('Failed for mario.rossi@example.com org 3f2b8c1e-1d2a-4b3c-8d4e-5f6a7b8c9d0e key sk_test_abcdefghijkl at https://x.it/p?token=abc 1234567')
    expect(s).toBe('Failed for <email> org <id> key <secret> at https://x.it/p?<query> <n>')
  })
  it('normalizza i percorsi e calcola impronte stabili', () => {
    expect(sanitizePath('/app/crm/3f2b8c1e-1d2a-4b3c-8d4e-5f6a7b8c9d0e?tab=1')).toBe('/app/crm/:id')
    expect(sanitizePath('javascript:alert(1)')).toBeNull()
    const a = buildErrorRow({ source: 'client', code: 'TypeError', message: 'x is undefined (user 12345)', path: '/app/crm/1' })
    const b = buildErrorRow({ source: 'client', code: 'TypeError', message: 'x is undefined (user 99999)', path: '/app/crm/2' })
    expect(a.p_fingerprint).toBe(b.p_fingerprint)
    expect(a.p_fingerprint).toMatch(/^[0-9a-f]{32}$/)
  })
  it('scarta release non valide', () => {
    expect(buildErrorRow({ source: 'function', code: 'E', release: 'abc 123<script>' }).p_release).toBeNull()
  })
})

describe('stato integrazioni', () => {
  it('riporta solo presenza e modalità, mai i valori', () => {
    const r = integrationStatus({ STRIPE_SECRET_KEY: 'sk_live_secretvalue', SUPABASE_URL: 'https://x.supabase.co' })
    expect(JSON.stringify(r).includes('secretvalue')).toBe(false)
    expect(r.find((i) => i.key === 'stripe')).toMatchObject({ state: 'partial', note: 'live_blocked' })
    expect(r.find((i) => i.key === 'supabase')?.state).toBe('partial')
    expect(r.find((i) => i.key === 'openai')?.state).toBe('missing')
  })
})

describe('notifiche di piattaforma', () => {
  it('senza configurazione non invia nulla', async () => {
    expect(notifyConfig({})).toBeNull()
    const prev = process.env.PLATFORM_NOTIFY_RESEND_API_KEY
    delete process.env.PLATFORM_NOTIFY_RESEND_API_KEY
    let called = false
    const r = await notifyPlatform('s', 't', (async () => { called = true; return new Response('{}') }) as typeof fetch)
    expect(r).toEqual({ sent: false, reason: 'not_configured' })
    expect(called).toBe(false)
    if (prev !== undefined) process.env.PLATFORM_NOTIFY_RESEND_API_KEY = prev
  })
  it('filtra i destinatari non validi', () => {
    expect(notifyConfig({ PLATFORM_NOTIFY_RESEND_API_KEY: 're_x', PLATFORM_NOTIFY_FROM: 'ops@leadflow.it', PLATFORM_NOTIFY_TO: 'a@b.it, non-valido' })?.to).toEqual(['a@b.it'])
  })
})
