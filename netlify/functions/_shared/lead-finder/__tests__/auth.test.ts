// @vitest-environment node
import { describe, expect, it, vi, beforeEach } from 'vitest'

/** Autorizzazione lato server: token obbligatorio e appartenenza all'organizzazione verificata. */
const state = { user: { id: 'u1' } as { id: string } | null, membership: null as { role: string } | null }
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: state.user }, error: state.user ? null : { message: 'invalid' } }) },
    from: () => {
      const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: state.membership, error: null }) }
      return q
    },
  }),
}))

const { requireOrgMember } = await import('../../auth')
const req = (token?: string) => new Request('https://app.example/api', { headers: token ? { authorization: `Bearer ${token}` } : {} })

describe('3. Autorizzazione server-side', () => {
  beforeEach(() => {
    process.env.SUPABASE_URL = 'https://x.supabase.co'
    process.env.SUPABASE_ANON_KEY = 'anon'
    state.user = { id: 'u1' }
    state.membership = null
  })
  it('senza token → 401', async () => {
    await expect(requireOrgMember(req(), 'org')).rejects.toMatchObject({ status: 401, code: 'missing_token' })
  })
  it('token non valido → 401', async () => {
    state.user = null
    await expect(requireOrgMember(req('bad'), 'org')).rejects.toMatchObject({ status: 401, code: 'invalid_token' })
  })
  it('utente di un’altra organizzazione → 403', async () => {
    await expect(requireOrgMember(req('ok'), 'org')).rejects.toMatchObject({ status: 403, code: 'forbidden' })
  })
  it('membro → autorizzato; azioni admin negate ai membri', async () => {
    state.membership = { role: 'member' }
    await expect(requireOrgMember(req('ok'), 'org')).resolves.toMatchObject({ role: 'member' })
    await expect(requireOrgMember(req('ok'), 'org', { admin: true })).rejects.toMatchObject({ status: 403 })
  })
})
