// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createMemoryStore } from './memoryStore'
import { ORG_A, OSM_ENV, USER_A, hotelProfile, jsonResponse, mockFetch, overpassBody, searchInput } from './fixtures'
import { createRegistry } from '../providers/registry'
import { runSearch, setExclusion } from '../services'
import { HttpError } from '../../http'
import type { BillingGate, LeadCountResult } from '../../billing/store'

/**
 * Gate di billing in memoria con la stessa semantica di billing_count_new_leads
 * (un riferimento contato una sola volta, mai oltre il limite). La semantica SQL reale,
 * inclusa la concorrenza, è verificata in supabase/tests/rls_tests_billing.sql e run_billing_concurrency.sh.
 */
function memoryGate(limit: number, opts: { enforced?: boolean; allowedFeature?: boolean } = {}) {
  const counted = new Set<string>()
  const providerCalls: string[] = []
  const enforced = opts.enforced ?? true
  const gate: BillingGate = {
    canUseFeature: async () => ({ allowed: opts.allowedFeature ?? true, reason: 'ok' }),
    leadQuota: async () =>
      enforced
        ? { enforced, allowed: counted.size < limit, reason: counted.size < limit ? null : 'lead_quota_exceeded', used: counted.size, limit, remaining: Math.max(limit - counted.size, 0) }
        : { enforced: false, allowed: true },
    countNewLeads: async (_org, _user, refs): Promise<LeadCountResult> => {
      if (!enforced) return { enforced: false, counted: 0, already_counted: 0, over_quota_refs: [] }
      let n = 0
      let already = 0
      const over: string[] = []
      for (const r of new Set(refs)) {
        if (counted.has(r)) already++
        else if (counted.size < limit) {
          counted.add(r)
          n++
        } else over.push(r)
      }
      return { enforced, counted: n, already_counted: already, over_quota_refs: over, used: counted.size, limit, remaining: limit - counted.size }
    },
    recordProviderCall: async (_o, _u, provider, key) => {
      providerCalls.push(`${provider}:${key}`)
    },
  }
  return { gate, counted, providerCalls }
}

function osm() {
  const f = mockFetch(() => jsonResponse(overpassBody))
  return { registry: createRegistry(OSM_ENV, f.fn), calls: f.calls }
}

describe('quota nuovi lead del piano nel Lead Finder', () => {
  it('quota esaurita → 402 prima di chiamare il provider (nessun costo)', async () => {
    const { store } = createMemoryStore({ profiles: { [ORG_A]: hotelProfile } })
    const { registry, calls } = osm()
    const { gate } = memoryGate(0)
    const err = await runSearch({ store, registry, billing: gate }, { orgId: ORG_A, userId: USER_A }, searchInput()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HttpError)
    expect((err as HttpError).status).toBe(402)
    expect((err as HttpError).code).toBe('billing_lead_quota_exceeded')
    expect(calls).toHaveLength(0)
  })

  it('i nuovi lead sono contati una volta; ripetere la ricerca non li riconta', async () => {
    const { store } = createMemoryStore({ profiles: { [ORG_A]: hotelProfile } })
    const { registry } = osm()
    const { gate, counted, providerCalls } = memoryGate(100)
    const first = await runSearch({ store, registry, billing: gate }, { orgId: ORG_A, userId: USER_A }, searchInput())
    expect(first.plan_leads).toMatchObject({ counted: 2, over_quota: 0, partial: false })
    const again = await runSearch({ store, registry, billing: gate }, { orgId: ORG_A, userId: USER_A }, searchInput())
    expect(again.counts.new).toBe(0)
    expect(again.plan_leads?.counted ?? 0).toBe(0)
    expect(counted.size).toBe(2)
    expect(providerCalls).toHaveLength(2)
  })

  it('ricerca parziale: limite risultati ridotto alla quota residua e oltre-quota esclusi', async () => {
    const { store, state } = createMemoryStore({ profiles: { [ORG_A]: hotelProfile } })
    // Registra le esclusioni (il motivo non è conservato dallo store in memoria).
    const reasons: (string | null | undefined)[] = []
    const update = store.updateCandidate.bind(store)
    store.updateCandidate = async (org, id, patch) => {
      if (patch.status === 'excluded') reasons.push(patch.excludedReason)
      return update(org, id, patch)
    }
    const { registry } = osm()
    const { gate, counted } = memoryGate(1)
    const res = await runSearch({ store, registry, billing: gate }, { orgId: ORG_A, userId: USER_A }, searchInput())
    // Limite risultati ridotto alla quota residua: ricerca parziale, nessun lead oltre quota.
    expect(res.plan_leads).toMatchObject({ partial: true, counted: 1, over_quota: 0 })
    expect(counted.size).toBe(1)
    expect(state.candidates.filter((c) => c.status === 'excluded')).toHaveLength(0)

    // Ricerca concorrente: la quota residua letta all'inizio (5) è stata consumata nel frattempo.
    const race = createMemoryStore({ profiles: { [ORG_A]: hotelProfile } })
    const raceReasons: (string | null | undefined)[] = []
    const raceUpdate = race.store.updateCandidate.bind(race.store)
    race.store.updateCandidate = async (org, id, patch) => {
      if (patch.status === 'excluded') raceReasons.push(patch.excludedReason)
      return raceUpdate(org, id, patch)
    }
    const raceGate = memoryGate(1).gate
    raceGate.leadQuota = async () => ({ enforced: true, allowed: true, used: 0, limit: 5, remaining: 5 })
    const r2 = await runSearch({ store: race.store, registry: osm().registry, billing: raceGate }, { orgId: ORG_A, userId: USER_A }, searchInput())
    expect(r2.plan_leads).toMatchObject({ counted: 1, over_quota: 1, partial: true })
    expect(race.state.candidates.filter((c) => c.status === 'excluded')).toHaveLength(1)
    expect(raceReasons).toEqual(['lead_quota_exceeded'])
    expect(reasons).toEqual([])
  })

  it('ripristino di un candidato escluso per quota: bloccato finché la quota è esaurita', async () => {
    const { store, state } = createMemoryStore({ profiles: { [ORG_A]: hotelProfile } })
    const { registry } = osm()
    const { gate } = memoryGate(2)
    await runSearch({ store, registry, billing: gate }, { orgId: ORG_A, userId: USER_A }, searchInput())
    const target = state.candidates[0]!
    await setExclusion({ store, billing: gate }, { orgId: ORG_A, userId: USER_A }, [target.id], true, 'manual')
    // Il candidato era già contato: il ripristino non consuma quota e riesce.
    const r1 = await setExclusion({ store, billing: gate }, { orgId: ORG_A, userId: USER_A }, [target.id], false)
    expect(r1).toEqual({ changed: 1 })
    // Un candidato mai contato (es. escluso per quota) non può tornare disponibile oltre il limite.
    target.status = 'excluded'
    const fresh = { ...target, id: crypto.randomUUID(), externalId: 'node/999' }
    state.candidates.push(fresh)
    const r2 = await setExclusion({ store, billing: gate }, { orgId: ORG_A, userId: USER_A }, [fresh.id], false)
    expect(r2).toEqual({ changed: 0, blocked_by_plan_quota: 1 })
  })

  it('billing non applicato (enforcement disattivo): comportamento invariato', async () => {
    const { store } = createMemoryStore({ profiles: { [ORG_A]: hotelProfile } })
    const { registry } = osm()
    const { gate } = memoryGate(0, { enforced: false })
    const res = await runSearch({ store, registry, billing: gate }, { orgId: ORG_A, userId: USER_A }, searchInput())
    expect(res.counts.new).toBe(2)
    expect(res.plan_leads).toBeUndefined()
  })
})
