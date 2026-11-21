import type { HelpLocale } from '../../../../../src/content/help'
import { retrieve, DEFAULT_RETRIEVAL, type RetrievalConfig } from '../chat'
import type { SupportCase } from './supportQuestions'

/** Lingua del caso: le domande inglesi del dataset iniziano con una parola interrogativa inglese. */
export function caseLocale(q: string): HelpLocale {
  return /^(how|what|is|can|do|does|where|why)\b/i.test(q.trim()) ? 'en' : 'it'
}

export interface SupportMetrics {
  n: number
  answerable: number
  unanswerable: number
  /** risposta giusta in prima posizione E sopra soglia, sulle domande coperte */
  precisionAt1: number
  /** articolo atteso tra i primi 3 (senza soglia), sulle domande coperte */
  recallAt3: number
  /** astensione corretta sulle domande non coperte */
  abstentionRate: number
  /** domande coperte a cui il bot si è astenuto (risposta mancata) */
  falseAbstentions: number
  /** domande non coperte a cui il bot ha risposto comunque */
  wrongAnswers: number
  failures: { id: string; expected: string | null; got: string | null; score: number }[]
}

export function evalSupport(cases: SupportCase[], cfg: RetrievalConfig = DEFAULT_RETRIEVAL): SupportMetrics {
  let p1 = 0, r3 = 0, abst = 0, falseAbst = 0, wrong = 0, answerable = 0, unanswerable = 0
  const failures: SupportMetrics['failures'] = []
  for (const k of cases) {
    const hits = retrieve(k.q, caseLocale(k.q), k.audience, 3, cfg)
    const top = hits[0]
    const answered = !!top && top.score >= cfg.minScore
    const got = answered ? top!.article.id : null
    if (k.expected === null) {
      unanswerable++
      if (!answered) abst++
      else { wrong++; failures.push({ id: k.id, expected: null, got, score: top!.score }) }
      continue
    }
    answerable++
    const ok = new Set([k.expected, ...(k.alt ?? [])])
    if (hits.some((h) => ok.has(h.article.id))) r3++
    if (got && ok.has(got)) p1++
    else {
      if (!answered) falseAbst++
      failures.push({ id: k.id, expected: k.expected, got, score: top?.score ?? 0 })
    }
  }
  const ratio = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 1000 : 0)
  return {
    n: cases.length, answerable, unanswerable,
    precisionAt1: ratio(p1, answerable), recallAt3: ratio(r3, answerable), abstentionRate: ratio(abst, unanswerable),
    falseAbstentions: falseAbst, wrongAnswers: wrong, failures,
  }
}
