// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { priorityFor, scoreLead, type ScorableCompany } from '../scoring'
import { hotelProfile } from './fixtures'
import { DEFAULT_WEIGHTS } from '../types'
import type { AnalysisResult } from '../analysis/schema'

const full: ScorableCompany = {
  companyName: 'Hotel Aurora', sector: 'hotel', categoryTags: ['tourism=hotel'], address: 'Via Nazionale 10', city: 'Roma', region: null, country: 'IT', website: 'https://hotelaurora.example', phone: '+39 06 1234567',
}
function analysis(over: Partial<AnalysisResult> = {}): AnalysisResult {
  return {
    version: 1, model: 'test', analyzed_at: '', website: { url: null, status: 'analyzed', fetched_at: null },
    sector: { value: 'Hotel', basis: 'verified', evidence: '' }, activity_description: { value: '', basis: 'missing', evidence: '' },
    verified_facts: [], hypotheses: [], digital_needs: [], opportunities: [], missing_information: [],
    fit: { sector_rating: 10, sector_reason: 'ok', icp_rating: 8, icp_reason: 'Struttura indipendente' },
    signals: [
      { signal: 'Nessun booking engine', evidence: 'prenota via email', verified: true },
      { signal: 'Assume personale', evidence: 'inventato', verified: false },
    ],
    qualification_reason: 'test', usage: { input_tokens: 0, output_tokens: 0 }, ...over,
  }
}

describe('6. Scoring coerente', () => {
  it('pesi predefiniti 30/20/25/15/10 e soglie di priorità', () => {
    expect(Object.values(DEFAULT_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100)
    expect([priorityFor(100), priorityFor(80), priorityFor(79), priorityFor(50), priorityFor(49), priorityFor(0)]).toEqual(['high', 'high', 'medium', 'medium', 'low', 'low'])
  })

  it('senza AI: solo criteri verificabili, base "rules", spiegazione per ogni criterio', () => {
    const r = scoreLead(full, hotelProfile, null)
    const pts = Object.fromEntries(r.breakdown.map((b) => [b.key, b.points]))
    expect(pts).toEqual({ sector: 30, geography: 20, icp: 0, signals: 0, completeness: 10 })
    expect(r.score).toBe(60)
    expect(r.priority).toBe('medium')
    expect(r.basis).toBe('rules')
    expect(r.breakdown.find((b) => b.key === 'icp')!.reason).toBe('icp_requires_ai')
    expect(r.breakdown.every((b) => b.points <= b.max)).toBe(true)
  })

  it('con AI: contano solo i segnali con evidenza verificata', () => {
    const r = scoreLead(full, hotelProfile, analysis())
    const sig = r.breakdown.find((b) => b.key === 'signals')!
    expect(sig.params?.count).toBe(1)
    expect(sig.points).toBe(5)
    expect(r.breakdown.find((b) => b.key === 'icp')!.points).toBe(20)
    expect(r.score).toBe(85)
    expect(r.priority).toBe('high')
    expect(r.basis).toBe('ai')
  })

  it('area, settore e completezza riducono il punteggio quando non corrispondono', () => {
    const r = scoreLead({ ...full, sector: 'restaurant', categoryTags: ['amenity=restaurant'], companyName: 'Trattoria Da Mario', city: 'Milano', phone: null, website: null }, hotelProfile, null)
    const pts = Object.fromEntries(r.breakdown.map((b) => [b.key, b.points]))
    expect(pts.sector).toBe(0)
    expect(pts.geography).toBe(8) // paese ok, città fuori area
    expect(pts.completeness).toBe(6)
    expect(r.priority).toBe('low')
  })

  it('profilo senza target: criteri neutri e ICP non configurato', () => {
    const r = scoreLead(full, { ...hotelProfile, targetSectors: [], targetRegions: [], targetCountries: [], idealCustomer: null, servicesDescription: null }, analysis())
    const reasons = Object.fromEntries(r.breakdown.map((b) => [b.key, b.reason]))
    expect(reasons).toMatchObject({ sector: 'sector_no_targets', geography: 'geo_no_targets', icp: 'icp_not_configured' })
  })

  it('pesi personalizzati applicati e totale sempre entro 0–100', () => {
    const w = { sector: 50, geography: 0, icp: 0, signals: 0, completeness: 50 }
    expect(scoreLead(full, { ...hotelProfile, weights: w }, null).score).toBe(100)
    expect(scoreLead({ ...full, sector: null, categoryTags: [], companyName: 'X', website: null, phone: null, address: null, city: null }, { ...hotelProfile, weights: w }, null).score).toBe(10)
  })

  it('stesso input → stesso punteggio (deterministico)', () => {
    expect(scoreLead(full, hotelProfile, analysis())).toEqual(scoreLead(full, hotelProfile, analysis()))
  })
})
