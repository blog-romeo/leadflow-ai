import type { AiAgentRunRow, AiWorkflowRow, AiWorkflowStepRow } from '../../lib/database.types'

/**
 * Esportazione dei risultati di un workflow (Prompt 9). Contiene solo dati dell'organizzazione corrente
 * già letti con RLS dalla pagina: nessuna chiamata aggiuntiva, nessun dato di altre organizzazioni.
 * Il CSV è protetto dalla formula injection (celle che iniziano con = + - @ tab o CR).
 */
type O = Record<string, unknown>
const obj = (v: unknown): O => (v && typeof v === 'object' && !Array.isArray(v) ? (v as O) : {})

export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : Array.isArray(v) ? v.join(' | ') : typeof v === 'object' ? JSON.stringify(v) : String(v)
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",;\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function rankingCsv(steps: AiWorkflowStepRow[]): string | null {
  const score = steps.find((s) => s.action === 'score' && s.status === 'completed')
  const ranked = Array.isArray(obj(score?.output).ranked) ? (obj(score?.output).ranked as O[]) : null
  if (!ranked) return null
  const head = ['rank', 'company_name', 'city', 'website', 'score', 'priority', 'basis', 'suggestion', 'missing', 'measure']
  const rows = ranked.map((r, i) => [i + 1, r.company_name, r.city, r.website, r.score, r.priority, r.basis, r.suggestion, r.missing, 'compatibility_index'])
  return [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n')
}

export function workflowJson(wf: AiWorkflowRow, steps: AiWorkflowStepRow[], runs: AiAgentRunRow[]): string {
  return JSON.stringify(
    {
      exported_at: new Date().toISOString(),
      notice: 'score = compatibility_index (not a purchase probability); drafts were never sent',
      workflow: { id: wf.id, template: wf.template, status: wf.status, objective: wf.objective, params: wf.params, credits_used: wf.credits_used, budget_credits: wf.budget_credits, cost_usd: wf.cost_usd, created_at: wf.created_at, completed_at: wf.completed_at, report: wf.report },
      steps: steps.map((s) => ({ position: s.position, agent: s.agent_key, action: s.action, status: s.status, error_code: s.error_code, attempts: s.attempts, started_at: s.started_at, completed_at: s.completed_at, output: s.output })),
      runs: runs.map((r) => ({ agent: r.agent_key, step_id: r.step_id, attempt: r.attempt, status: r.status, error_code: r.error_code, credits: r.credits_used, tokens_input: r.tokens_input, tokens_output: r.tokens_output, cost_usd: r.cost_usd, model: r.model, started_at: r.started_at, completed_at: r.completed_at })),
    },
    null,
    2,
  )
}

export function download(filename: string, mime: string, content: string) {
  const blob = new Blob([mime.startsWith('text/csv') ? `﻿${content}` : content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Durata di un passo (in corso: fino a ora). */
export function stepDurationMs(step: Pick<AiWorkflowStepRow, 'started_at' | 'completed_at' | 'status'>, now = Date.now()): number | null {
  if (!step.started_at) return null
  const end = step.completed_at ? new Date(step.completed_at).getTime() : step.status === 'running' ? now : null
  return end === null ? null : Math.max(0, end - new Date(step.started_at).getTime())
}

/** Elementi già elaborati dal tentativo in corso (checkpoint salvato dal motore). */
export function progressDone(step: Pick<AiWorkflowStepRow, 'output' | 'status'>): number | null {
  if (step.status !== 'running' && step.status !== 'pending') return null
  const p = obj(obj(step.output).progress)
  const map = obj(p.processed ?? p.items)
  const n = Object.keys(map).length
  return n > 0 ? n : null
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return '—'
  if (ms < 1000) return `${ms} ms`
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`
}
