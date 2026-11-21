import type { Dataset } from './types'

/**
 * Output dei passi (strategia, classifica, ricerca) con difetti etichettati, per misurare i controlli di
 * qualità: schema e postcheck (baseline, Prompt 9) e Quality Reviewer (candidato, Prompt 12).
 * `expected` = difetti che un revisore umano segnalerebbe. Contiene anche casi di DATI INSUFFICIENTI
 * (astensione corretta: niente FACT senza evidenze) e casi puliti per misurare i falsi positivi.
 */
export interface ReviewCase {
  id: string
  action: 'strategy' | 'score' | 'research' | 'discover'
  output: Record<string, unknown>
  context?: { research?: Record<string, unknown>; leadToCandidate?: Record<string, string> }
  /** Codici attesi (insieme). Vuoto = output corretto. */
  expected: string[]
}

const L1 = '00000000-0000-4000-8000-0000000000a1'
const L2 = '00000000-0000-4000-8000-0000000000a2'
const L3 = '00000000-0000-4000-8000-0000000000a3'
const C1 = '00000000-0000-4000-8000-0000000000c1'
const C2 = '00000000-0000-4000-8000-0000000000c2'
const C3 = '00000000-0000-4000-8000-0000000000c3'

const strat = (lead: string, over: Record<string, unknown> = {}, item: Record<string, unknown> = {}) => ({
  lead_id: lead, status: 'generated', draft_id: null, warnings: [],
  strategy: {
    opportunity: { statement: 'Le prenotazioni avvengono via email', basis: 'fact', evidence: 'Per prenotare scrivete una email' },
    value_proposition: `Proposta per ${lead.slice(-2)}: prenotazione diretta`, approach: { channel: 'email', steps: ['Email', `Call ${lead.slice(-2)}`] },
    missing_information: ['Numero di camere'], ...over,
  },
  ...item,
})
const stratOut = (items: unknown[]) => ({ strategies: items, counts: { total: items.length, generated: items.length, cached: 0, failed: 0 }, no_messages_sent: true })
const research = { results: { [C1]: 'analyzed', [C2]: 'failed', [C3]: 'analyzed' } }
const map = { [L1]: C1, [L2]: C2, [L3]: C3 }
const rank = (id: string, score: number, priority: string, basis = 'ai', evidence = ['hotel']) => ({ candidate_id: id, score, priority, basis, evidence, missing: [] })
const scoreOut = (ranked: unknown[]) => ({ ranked, eligible_ids: [], counts: { total: ranked.length, eligible: 0, high: 0, medium: 0, low: 0 }, measure: 'compatibility_index' })

export const outputReviewV1: Dataset<ReviewCase> = {
  id: 'output_review',
  version: '1.0.0',
  task: 'output_quality_review',
  synthetic: true,
  notice: 'Output sintetici costruiti a mano con difetti noti; nessun output di un modello reale.',
  splits: {
    train: [
      { id: 'or-tr-01', action: 'strategy', output: stratOut([strat(L1), strat(L3)]), context: { research, leadToCandidate: map }, expected: [] },
      { id: 'or-tr-02', action: 'strategy', output: stratOut([strat(L2)]), context: { research, leadToCandidate: map }, expected: ['strategy_unsupported'] },
      { id: 'or-tr-03', action: 'strategy', output: stratOut([strat(L1, { value_proposition: '' })]), context: { research, leadToCandidate: map }, expected: ['incomplete_output'] },
      { id: 'or-tr-04', action: 'score', output: scoreOut([rank(C1, 85, 'high'), rank(C1, 85, 'high')]), expected: ['duplicate_ids'] },
      { id: 'or-tr-05', action: 'score', output: scoreOut([rank(C1, 40, 'high')]), expected: ['contradiction'] },
      { id: 'or-tr-06', action: 'research', output: { counts: { total: 3, analyzed: 1, cached: 0, failed: 0, skipped: 0, facts: 2, inferences: 1, unknowns: 0 }, results: { a: 'analyzed' } }, expected: ['contradiction'] },
      { id: 'or-tr-07', action: 'strategy', output: stratOut([strat(L1, { opportunity: { statement: 'Hotel con SPA', basis: 'fact', evidence: '' } })]), context: { research, leadToCandidate: map }, expected: ['unsourced_fact'] },
      { id: 'or-tr-08', action: 'score', output: scoreOut([rank(C1, 82, 'high'), rank(C2, 55, 'medium', 'rules', [])]), expected: [] },
    ],
    validation: [
      { id: 'or-va-01', action: 'strategy', output: stratOut([strat(L3)]), context: { research, leadToCandidate: map }, expected: [] },
      { id: 'or-va-02', action: 'strategy', output: stratOut([strat(L2, {}, { warnings: [{ code: 'unverified_fact' }] })]), context: { research, leadToCandidate: map }, expected: ['strategy_unsupported', 'claim_not_verified'] },
      { id: 'or-va-03', action: 'strategy', output: stratOut([strat(L1), strat(L1)]), context: { research, leadToCandidate: map }, expected: ['duplicate_ids'] },
      { id: 'or-va-04', action: 'score', output: scoreOut([rank(C3, 51, 'low')]), expected: ['contradiction'] },
      { id: 'or-va-05', action: 'discover', output: { done: true, provider: 'osm_overpass', search_id: 's', candidate_ids: [C1, C2], counts: { total: 3, found: 3, new: 2, kept: 3 } }, expected: ['contradiction'] },
      { id: 'or-va-06', action: 'score', output: scoreOut([rank(C2, 90, 'high', 'ai', [])]), expected: ['unsourced_fact'] },
      { id: 'or-va-07', action: 'strategy', output: stratOut([strat(L1, { approach: { channel: 'email', steps: [] } })]), context: { research, leadToCandidate: map }, expected: ['incomplete_output'] },
      { id: 'or-va-08', action: 'research', output: { counts: { total: 2, analyzed: 2, cached: 0, failed: 0, skipped: 0, facts: 3, inferences: 2, unknowns: 1 }, results: { a: 'analyzed', b: 'analyzed' } }, expected: [] },
    ],
    test: [
      { id: 'or-te-01', action: 'strategy', output: stratOut([strat(L3, { opportunity: { statement: 'Prenotazioni gestite a mano via email', basis: 'fact', evidence: 'scrivete una email alla reception' } })]), context: { research, leadToCandidate: map }, expected: [] },
      // Dati insufficienti: la Research è fallita per questa azienda → una strategia FACT non è supportata.
      { id: 'or-te-02', action: 'strategy', output: stratOut([strat(L2, { opportunity: { statement: 'Usa un vecchio gestionale', basis: 'fact', evidence: 'gestionale' } })]), context: { research, leadToCandidate: map }, expected: ['strategy_unsupported'] },
      { id: 'or-te-03', action: 'strategy', output: stratOut([strat(L3, { opportunity: { statement: 'Numero di camere elevato', basis: 'fact', evidence: 'molte camere' }, missing_information: ['numero di camere'] })]), context: { research, leadToCandidate: map }, expected: ['contradiction'] },
      { id: 'or-te-04', action: 'strategy', output: stratOut([strat(L1, { value_proposition: 'Stessa proposta', approach: { channel: 'email', steps: ['A'] } }), strat(L3, { value_proposition: 'Stessa proposta', approach: { channel: 'email', steps: ['A'] } })]), context: { research, leadToCandidate: map }, expected: ['duplicate_content'] },
      { id: 'or-te-05', action: 'score', output: scoreOut([rank(C1, 80, 'medium'), rank(C2, 79, 'medium')]), expected: ['contradiction'] },
      { id: 'or-te-06', action: 'score', output: scoreOut([rank(C1, 30, 'low', 'rules', []), rank(C3, 65, 'medium')]), expected: [] },
      { id: 'or-te-07', action: 'research', output: { counts: { total: 2, analyzed: 2, cached: 0, failed: 0, skipped: 0, facts: 0, inferences: 0, unknowns: 0 }, results: { a: 'analyzed', b: 'analyzed' } }, expected: ['incomplete_output'] },
      { id: 'or-te-08', action: 'strategy', output: stratOut([strat(L3, { opportunity: { statement: 'Prenotazione via telefono', basis: 'fact', evidence: '' } })]), context: { research, leadToCandidate: map }, expected: ['unsourced_fact'] },
    ],
  },
}
