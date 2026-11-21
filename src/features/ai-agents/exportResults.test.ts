import { describe, expect, it } from 'vitest'
import type { AiWorkflowStepRow } from '../../lib/database.types'
import { csvCell, formatDuration, progressDone, rankingCsv, stepDurationMs } from './exportResults'

const step = (over: Partial<AiWorkflowStepRow>): AiWorkflowStepRow =>
  ({ id: 's', organization_id: 'o', workflow_id: 'w', position: 3, agent_key: 'scoring', action: 'score', depends_on: [], requires_approval: false, status: 'completed', attempts: 1, max_attempts: 2, timeout_seconds: 60, input: {}, output: null, error_code: null, started_at: null, completed_at: null, created_at: '', updated_at: '', ...over }) as AiWorkflowStepRow

describe('esportazione risultati workflow (Prompt 9)', () => {
  it('CSV protetto dalla formula injection e con escape', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`)
    expect(csvCell('+39 06')).toBe("'+39 06")
    expect(csvCell('a;b')).toBe('"a;b"')
    expect(csvCell(['website', 'phone'])).toBe('website | phone')
    expect(csvCell(null)).toBe('')
  })
  it('classifica solo da un passo di scoring completato', () => {
    expect(rankingCsv([step({ status: 'running', output: { ranked: [] } })])).toBeNull()
    const csv = rankingCsv([step({ output: { ranked: [{ company_name: 'Hotel A', city: 'Roma', score: 81, priority: 'high', missing: [] }] } })])!
    expect(csv.split('\r\n')).toHaveLength(2)
    expect(csv).toContain('1,Hotel A,Roma,,81,high')
    expect(csv).toContain('compatibility_index')
  })
  it('durata e avanzamento dei passi', () => {
    expect(stepDurationMs(step({ started_at: '2026-11-21T10:00:00Z', completed_at: '2026-11-21T10:01:05Z' }))).toBe(65_000)
    expect(stepDurationMs(step({ status: 'running', started_at: '2026-11-21T10:00:00Z' }), Date.parse('2026-11-21T10:00:10Z'))).toBe(10_000)
    expect(formatDuration(65_000)).toBe('1 min 5 s')
    expect(progressDone(step({ status: 'running', output: { progress: { processed: { a: 'analyzed', b: 'failed' } } } }))).toBe(2)
    expect(progressDone(step({ status: 'completed', output: { progress: { processed: { a: 'x' } } } }))).toBeNull()
  })
})
