import { describe, expect, it } from 'vitest'
import { createInvite, inviteEmail, inviteUrl, type InviteDeps } from '../invite'
import { sendPlatformEmail } from '../../launch/notify'

const TOKEN = 'a'.repeat(48)
function deps(send: InviteDeps['send']) {
  const marks: [string, string | null][] = []
  const d: InviteDeps = {
    appUrl: 'https://app.leadflow.it/',
    create: async (email, role) => ({ id: 'inv-1', token: TOKEN, expires_at: '2026-11-27T10:00:00Z', email: email.trim().toLowerCase(), role }),
    context: async () => ({ organizationName: 'Team A Srl\r\nBcc: x@y.it', inviterName: 'Anna' }),
    send,
    markEmail: async (id, e) => void marks.push([id, e]),
  }
  return { d, marks }
}

describe('inviti collaboratori (server)', () => {
  it('link con il token nel frammento, mai nella query', () => {
    expect(inviteUrl('https://app.leadflow.it/', TOKEN)).toBe(`https://app.leadflow.it/join#t=${TOKEN}`)
    expect(() => inviteUrl('https://x.it', 'non-valido')).toThrow()
  })
  it('email inviata: il link NON viene restituito all’admin', async () => {
    const sent: string[] = []
    const { d, marks } = deps(async (to, _s, text) => { sent.push(to, text); return { sent: true } })
    const r = await createInvite(d, { email: 'Marco@Team-A.it', role: 'member', locale: 'it' })
    expect(r.email_status).toBe('sent')
    expect('invite_url' in r).toBe(false)
    expect(sent[0]).toBe('marco@team-a.it')
    expect(sent[1]).toContain(`/join#t=${TOKEN}`)
    expect(marks).toEqual([['inv-1', null]])
  })
  it('provider non configurato: invito creato, email dichiarata NON inviata, link per consegna manuale', async () => {
    const { d, marks } = deps(async () => ({ sent: false, reason: 'not_configured' }))
    const r = await createInvite(d, { email: 'marco@team-a.it', role: undefined, locale: 'it' })
    expect(r).toMatchObject({ email_status: 'not_configured', role: 'member', invite_url: `https://app.leadflow.it/join#t=${TOKEN}` })
    expect(marks).toEqual([['inv-1', 'not_configured']])
  })
  it('errore del provider: stato "failed"', async () => {
    const { d } = deps(async () => ({ sent: false, reason: 'provider_error' }))
    expect((await createInvite(d, { email: 'm@t.it', role: 'organization_admin', locale: 'en' })).email_status).toBe('failed')
  })
  it('ruolo non ammesso rifiutato prima di creare l’invito', async () => {
    let created = false
    const { d } = deps(async () => ({ sent: true }))
    d.create = async () => { created = true; throw new Error() }
    await expect(createInvite(d, { email: 'm@t.it', role: 'super_admin', locale: 'it' })).rejects.toMatchObject({ code: 'invalid_role' })
    expect(created).toBe(false)
  })
  it('testo email senza a capo nell’oggetto (nessuna header injection)', () => {
    const m = inviteEmail('it', { organizationName: 'A\r\nBcc: x@y.it', inviterName: null, url: 'https://x.it/join#t=1', expiresAt: '2026-11-27T10:00:00Z' })
    expect(/[\r\n]/.test(m.subject)).toBe(false)
    expect(m.text).toContain('27/11/2026')
  })
  it('invio piattaforma: senza chiave non parte nessuna richiesta', async () => {
    let called = false
    const r = await sendPlatformEmail('a@b.it', 's', 't', {}, (async () => { called = true; return new Response('{}') }) as typeof fetch)
    expect(r).toEqual({ sent: false, reason: 'not_configured' })
    expect(called).toBe(false)
  })
  it('invio piattaforma: un solo destinatario, oggetto ripulito', async () => {
    let body: { to: string[]; subject: string } | null = null
    const r = await sendPlatformEmail('a@b.it', 'Ciao\nBcc: x', 't', { PLATFORM_NOTIFY_RESEND_API_KEY: 're_x', PLATFORM_NOTIFY_FROM: 'noreply@lf.it' },
      (async (_u: string, init: RequestInit) => { body = JSON.parse(String(init.body)); return new Response('{}', { status: 200 }) }) as typeof fetch)
    expect(r).toEqual({ sent: true })
    expect(body).toMatchObject({ to: ['a@b.it'], subject: 'Ciao Bcc: x' })
  })
})
