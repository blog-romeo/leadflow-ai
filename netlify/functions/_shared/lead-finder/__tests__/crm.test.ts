// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createMemoryStore } from './memoryStore'
import { GOOGLE_ENV, ORG_A, ORG_B, OSM_ENV, USER_A, USER_B, googlePage2, jsonResponse, mockFetch, overpassBody, searchInput } from './fixtures'
import { createRegistry } from '../providers/registry'
import { csvCell, exportCandidatesCsv, importCsv, runSearch, saveToCrm, setExclusion } from '../services'
import type { ProviderId } from '../types'

const labels: Record<ProviderId, string> = { osm_overpass: 'OpenStreetMap (Overpass)', google_places: 'Google Places', csv_import: 'CSV' }

async function seededOsm() {
  const mem = createMemoryStore()
  const registry = createRegistry(OSM_ENV, mockFetch(() => jsonResponse(overpassBody)).fn)
  await runSearch({ store: mem.store, registry }, { orgId: ORG_A, userId: USER_A }, searchInput())
  return mem
}

describe('5. Salvataggio nel CRM', () => {
  it('crea il lead con provenienza, punteggio e fonte unica per provider', async () => {
    const { store, state } = await seededOsm()
    const ids = state.candidates.map((c) => c.id)
    const res = await saveToCrm({ store, providerLabels: labels }, { orgId: ORG_A, userId: USER_A }, ids)
    expect(res.saved).toBe(2)
    expect(state.sources).toHaveLength(1)
    const lead = state.leads.find((l) => l.externalId === 'node/101')!
    expect(lead).toMatchObject({ provider: 'osm_overpass', companyName: 'Hotel Aurora', dedupKey: 'hotelaurora.example', createdBy: USER_A })
    expect(lead.notes).toContain('openstreetmap.org/node/101')
    expect(lead.scoreBreakdown?.length).toBe(5)
    expect(state.candidates.every((c) => c.status === 'saved' && c.leadId)).toBe(true)
    expect(state.audit.some((a) => a.action === 'lead_finder.saved_to_crm')).toBe(true)
  })

  it('salvare due volte non duplica; stessa azienda da altra fonte risulta duplicata', async () => {
    const { store, state } = await seededOsm()
    const ids = state.candidates.map((c) => c.id)
    await saveToCrm({ store, providerLabels: labels }, { orgId: ORG_A, userId: USER_A }, ids)
    const again = await saveToCrm({ store, providerLabels: labels }, { orgId: ORG_A, userId: USER_A }, ids)
    expect(again.results.every((r) => r.outcome === 'already_saved')).toBe(true)

    const imp = await importCsv({ store }, { orgId: ORG_A, userId: USER_A }, {
      search_id: crypto.randomUUID(),
      file_name: 'clienti.csv',
      source: { name: 'Fiera 2026', legal_basis: 'legitimate_interest' },
      rows: [{ company_name: 'Hotel Aurora srl', website: 'hotelaurora.example', city: 'Roma' }],
    })
    expect(imp.counts.in_crm).toBe(1)
    const csvCand = state.candidates.find((c) => c.provider === 'csv_import')!
    const dup = await saveToCrm({ store, providerLabels: labels }, { orgId: ORG_A, userId: USER_A }, [csvCand.id])
    expect(dup.results[0]!.outcome).toBe('duplicate')
    expect(state.leads).toHaveLength(2)
  })

  it('risultati Google non salvabili (licenza), esclusi non salvabili, org diversa non trovata', async () => {
    const mem = createMemoryStore()
    const registry = createRegistry(GOOGLE_ENV, mockFetch(() => jsonResponse(googlePage2)).fn)
    await runSearch({ store: mem.store, registry }, { orgId: ORG_A, userId: USER_A }, searchInput({ provider: 'google_places' }))
    const g = mem.state.candidates[0]!
    const r1 = await saveToCrm({ store: mem.store, providerLabels: labels }, { orgId: ORG_A, userId: USER_A }, [g.id])
    expect(r1.results[0]!.outcome).toBe('not_allowed')

    const { store, state } = await seededOsm()
    const [first, second] = state.candidates
    await setExclusion({ store }, { orgId: ORG_A, userId: USER_A }, [first!.id], true, 'Già cliente di un concorrente')
    const r2 = await saveToCrm({ store, providerLabels: labels }, { orgId: ORG_A, userId: USER_A }, [first!.id])
    expect(r2.results[0]!.outcome).toBe('excluded')
    const r3 = await saveToCrm({ store, providerLabels: labels }, { orgId: ORG_B, userId: USER_B }, [second!.id])
    expect(r3.results[0]!.outcome).toBe('not_found')
    expect(state.leads).toHaveLength(0)
  })

  it('l’esclusione persiste nelle ricerche successive', async () => {
    const { store, state } = await seededOsm()
    await setExclusion({ store }, { orgId: ORG_A, userId: USER_A }, [state.candidates[0]!.id], true)
    const registry = createRegistry(OSM_ENV, mockFetch(() => jsonResponse(overpassBody)).fn)
    const res = await runSearch({ store, registry }, { orgId: ORG_A, userId: USER_A }, searchInput())
    expect(res.counts.excluded).toBe(1)
    expect(state.candidates[0]!.status).toBe('excluded')
  })
})

describe('Importazione CSV', () => {
  it('valida le righe, segnala gli errori e registra la base giuridica', async () => {
    const { store, state } = createMemoryStore()
    const res = await importCsv({ store }, { orgId: ORG_A, userId: USER_A }, {
      search_id: crypto.randomUUID(),
      file_name: 'lista.csv',
      source: { name: 'Elenco soci associazione', legal_basis: 'consent' },
      rows: [
        { company_name: 'Studio Rossi', website: 'studiorossi.example', city: 'Milano', country: 'it' },
        { company_name: 'Studio Rossi bis', website: 'https://studiorossi.example' },
        { company_name: '', city: 'Torino' },
        { company_name: 'Sito errato', website: 'javascript:alert(1)' },
        { company_name: 'Paese errato', country: 'Italia' },
      ],
    })
    expect(res.counts).toMatchObject({ rows: 5, valid: 2, invalid: 3, new: 1, duplicates_in_batch: 1 })
    expect(res.invalid).toEqual([{ row: 3, error: 'company_name' }, { row: 4, error: 'website' }, { row: 5, error: 'country' }])
    expect(state.sources[0]).toMatchObject({ type: 'csv_import', legalBasis: 'consent' })
    // Un sito "javascript:" non viene mai accettato come URL.
    expect(state.candidates.every((c) => !c.website || c.website.startsWith('https://'))).toBe(true)
  })

  it('rispetta la quota di risultati', async () => {
    const { store } = createMemoryStore({ quotas: { [ORG_A]: { monthly_searches: 10, monthly_results: 1, monthly_ai_analyses: 1, requests_per_minute: 20 } } })
    const err = await importCsv({ store }, { orgId: ORG_A, userId: USER_A }, {
      search_id: crypto.randomUUID(),
      file_name: 'x.csv',
      source: { name: 'Lista', legal_basis: 'contract' },
      rows: [{ company_name: 'A', city: 'Roma' }, { company_name: 'B', city: 'Roma' }],
    }).catch((e) => e)
    expect(err.code).toBe('quota_results_exceeded')
  })
})

describe('Esportazione CSV', () => {
  it('esporta solo i dati consentiti, con attribuzione e protezione da formula injection', async () => {
    const { store, state } = await seededOsm()
    state.candidates.push({ ...state.candidates[0]!, id: 'g', provider: 'google_places', externalId: 'ChIJ', canExport: false, companyName: null })
    const { csv, rows } = await exportCandidatesCsv({ store }, { orgId: ORG_A, userId: USER_A }, null)
    expect(rows).toBe(2)
    expect(csv).toContain('© OpenStreetMap contributors')
    expect(csv).not.toContain('ChIJ')
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`)
    expect(csvCell('+39 06 123')).toBe("'+39 06 123")
  })
})
