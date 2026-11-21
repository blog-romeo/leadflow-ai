import { describe, expect, it } from 'vitest'
import { configuredFor, connectionState } from './connectionState'

const NOW = Date.parse('2026-11-21T12:00:00Z')
const check = (status: 'verified' | 'failed' | 'not_configured', hoursAgo: number) => ({ key: 'overpass', status, code: 'ok', latency_ms: 10, checked_at: new Date(NOW - hoursAgo * 3_600_000).toISOString() })

describe('stato delle connessioni (Prompt 10)', () => {
  it('mai "verificato" senza un esito reale recente', () => {
    expect(connectionState(false, check('verified', 1), NOW)).toBe('not_configured')
    expect(connectionState(true, undefined, NOW)).toBe('configured_unverified')
    expect(connectionState(true, check('verified', 1), NOW)).toBe('verified')
    expect(connectionState(true, check('verified', 30), NOW)).toBe('verification_stale')
    expect(connectionState(true, check('failed', 0), NOW)).toBe('failed')
  })
  it('un livello che ricade sul modello standard non ha un modello proprio', () => {
    const av = { ai: { configured: true }, providers: [{ id: 'osm_overpass', configured: false }], models: { standard: { model_configured: true, fallback: false }, advanced: { model_configured: true, fallback: true } } }
    expect(configuredFor('openai_standard', av)).toBe(true)
    expect(configuredFor('openai_advanced', av)).toBe(false)
    expect(configuredFor('overpass', av)).toBe(false)
  })
})
