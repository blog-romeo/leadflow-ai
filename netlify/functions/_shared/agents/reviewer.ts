import { priorityFor } from '../lead-finder/scoring'
import type { StepAction } from './types'

/**
 * Quality Reviewer (Prompt 12) — fase LOGICA di validazione dopo ogni passo, senza un nuovo modello AI.
 * Regole deterministiche e verificabili sull'output già validato dallo schema (envelope.ts):
 *
 *  format_error         campo atteso mancante o di tipo errato (ridondante con lo schema: difesa in profondità)
 *  unsourced_fact       un'affermazione marcata FACT senza estratto/fonte
 *  claim_not_verified   il postcheck ha declassato un fatto non trovato nei dati
 *  incomplete_output    elementi "riusciti" senza le parti essenziali (es. strategia senza proposta di valore)
 *  duplicate_ids        lo stesso candidato/lead compare più volte (errore di integrità → BLOCCA)
 *  duplicate_content    bozze identiche per lead diversi (personalizzazione assente)
 *  contradiction        dati incoerenti (priorità ≠ punteggio → BLOCCA; conteggi che non tornano)
 *  strategy_unsupported strategia FACT su un'azienda senza evidenze della Research, o senza alcun fatto
 *
 * Le regole "BLOCCA" fermano il passo (`review_blocked`, nessun retry); le altre sono avvisi mostrati
 * all'utente e conteggiati nel monitoraggio. L'elenco dei codici bloccanti è configurabile solo tramite una
 * versione di configurazione approvata dal Super Admin (training/configVersions), mai dagli agenti.
 */
export type ReviewCode =
  | 'format_error'
  | 'unsourced_fact'
  | 'claim_not_verified'
  | 'incomplete_output'
  | 'duplicate_ids'
  | 'duplicate_content'
  | 'contradiction'
  | 'strategy_unsupported'

export interface ReviewFinding {
  code: ReviewCode
  /** Riferimento all'elemento (id del candidato o del lead), mai testo libero generato. */
  ref: string | null
  detail: string
}

export interface ReviewResult {
  findings: ReviewFinding[]
  blocking: ReviewFinding[]
  checked: number
}

export const DEFAULT_BLOCKING: readonly ReviewCode[] = ['duplicate_ids', 'contradiction']

type O = Record<string, unknown>
const obj = (v: unknown): O => (v && typeof v === 'object' && !Array.isArray(v) ? (v as O) : {})
const arr = <T = O>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : [])
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

function dupes(ids: string[]): string[] {
  const seen = new Set<string>()
  const out = new Set<string>()
  for (const id of ids) (seen.has(id) ? out : seen).add(id)
  return [...out]
}

export interface ReviewContext {
  /** Output della Research (risultati per candidato), se presente nel workflow. */
  research?: O | null
  /** Mappa lead → candidato (dal salvataggio nel CRM), per collegare strategie ed evidenze. */
  leadToCandidate?: Record<string, string>
}

export function reviewStep(action: StepAction, output: O, ctx: ReviewContext = {}, blockingCodes: readonly ReviewCode[] = DEFAULT_BLOCKING): ReviewResult {
  const f: ReviewFinding[] = []
  const add = (code: ReviewCode, ref: string | null, detail: string) => f.push({ code, ref, detail: detail.slice(0, 160) })
  let checked = 0

  if (action === 'discover') {
    const ids = arr<string>(output.candidate_ids)
    checked = ids.length
    for (const d of dupes(ids)) add('duplicate_ids', d, 'candidate_id ripetuto')
    const c = obj(output.counts)
    if (num(c.kept) !== ids.length) add('contradiction', null, `counts.kept=${num(c.kept)} ma candidate_ids=${ids.length}`)
  }

  if (action === 'research') {
    const c = obj(output.counts)
    const results = obj(output.results)
    checked = Object.keys(results).length
    const sum = num(c.analyzed) + num(c.cached) + num(c.failed) + num(c.skipped)
    if (num(c.total) > 0 && sum !== num(c.total)) add('contradiction', null, `analizzati+cache+falliti+saltati=${sum} su totale ${num(c.total)}`)
    if ((num(c.analyzed) + num(c.cached)) > 0 && num(c.facts) + num(c.inferences) + num(c.unknowns) === 0) add('incomplete_output', null, 'analisi riuscite senza alcuna evidenza classificata')
  }

  if (action === 'score') {
    const ranked = arr(output.ranked)
    checked = ranked.length
    for (const d of dupes(ranked.map((r) => str(r.candidate_id)))) add('duplicate_ids', d, 'candidato classificato più volte')
    for (const r of ranked) {
      if (r.priority !== priorityFor(num(r.score))) add('contradiction', str(r.candidate_id), `priorità ${String(r.priority)} incoerente con punteggio ${num(r.score)}`)
      if (r.basis === 'ai' && arr(r.evidence).length === 0) add('unsourced_fact', str(r.candidate_id), 'punteggio con analisi AI ma senza evidenze')
    }
  }

  if (action === 'strategy') {
    const items = arr(output.strategies)
    checked = items.length
    for (const d of dupes(items.map((i) => str(i.lead_id)))) add('duplicate_ids', d, 'lead con più strategie nello stesso passo')
    const bodies = new Map<string, string>()
    const researchResults = obj(ctx.research?.results)
    for (const it of items) {
      const lead = str(it.lead_id)
      if (it.status !== 'generated' && it.status !== 'cached') continue
      const s = obj(it.strategy)
      const opp = obj(s.opportunity)
      if (!str(s.value_proposition) || !str(opp.statement) || arr(obj(s.approach).steps).length === 0) add('incomplete_output', lead, 'strategia senza proposta di valore, opportunità o passi di approccio')
      if (opp.basis === 'fact' && !str(opp.evidence)) add('unsourced_fact', lead, 'opportunità FACT senza estratto')
      for (const w of arr(it.warnings)) if (w.code === 'unverified_fact') add('claim_not_verified', lead, 'fatto non trovato nei dati e declassato a deduzione')
      const missing = arr<string>(s.missing_information).map((m) => m.toLowerCase())
      if (opp.basis === 'fact' && str(opp.statement) && missing.some((m) => m.length > 6 && str(opp.statement).toLowerCase().includes(m))) add('contradiction', lead, "l'opportunità FACT è anche indicata come informazione mancante")
      const cand = ctx.leadToCandidate?.[lead]
      if (cand && ctx.research) {
        const st = researchResults[cand]
        if (opp.basis === 'fact' && st !== 'analyzed' && st !== 'cached') add('strategy_unsupported', lead, `strategia FACT ma Research: ${String(st ?? 'non eseguita')}`)
      }
      const draftId = str(it.draft_id)
      const key = `${str(s.value_proposition)}|${arr<string>(obj(s.approach).steps).join('|')}`
      if (draftId || key.length > 1) {
        const prev = bodies.get(key)
        if (prev && prev !== lead) add('duplicate_content', lead, `stessa proposta del lead ${prev}`)
        else bodies.set(key, lead)
      }
    }
  }

  if (action === 'follow_up.analyze') {
    const create = arr(obj(output.proposal).create)
    checked = create.length
    const keys = create.map((c) => `${str(c.leadId ?? c.lead_id)}:${str(c.kind)}`)
    for (const d of dupes(keys)) add('duplicate_ids', d, 'promemoria duplicato per lo stesso lead')
  }

  const blocking = f.filter((x) => blockingCodes.includes(x.code))
  return { findings: f.slice(0, 100), blocking, checked }
}

/** Riepilogo compatto per l'envelope e il report (solo conteggi per codice). */
export function reviewSummary(r: ReviewResult): { checked: number; findings: Record<string, number>; blocking: number } {
  const counts: Record<string, number> = {}
  for (const x of r.findings) counts[x.code] = (counts[x.code] ?? 0) + 1
  return { checked: r.checked, findings: counts, blocking: r.blocking.length }
}
