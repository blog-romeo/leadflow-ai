import { useState } from 'react'
import { ThumbsDown, ThumbsUp } from 'lucide-react'
import { useI18n } from '../../i18n'
import { supabase } from '../../lib/supabase'
import type { AiAgentKey, AiFeedbackRow } from '../../lib/database.types'
import { Button } from '../../components/ui/Button'
import { Badge } from '../../components/ui/Badge'

/**
 * Feedback umano (Prompt 12). Il feedback resta nell'organizzazione: un amministratore lo valida e, se lo
 * autorizza, diventa un esempio nella memoria aziendale ISOLATA. Non aggiorna modelli né prompt.
 */
export function FeedbackButtons({ orgId, workflowId, agent, subjectType, subjectId, correction }: { orgId: string; workflowId: string; agent: AiAgentKey; subjectType: 'lead' | 'candidate'; subjectId: string; correction?: Record<string, string> }) {
  const { t } = useI18n()
  const [state, setState] = useState<'idle' | 'sent' | 'error'>('idle')
  async function send(rating: 1 | -1) {
    if (!supabase) return
    const comment = rating < 0 ? (window.prompt(t('aiFeedback.commentPrompt')) ?? '').slice(0, 1000) : ''
    const { error } = await supabase.rpc('ai_feedback_submit', { p_org: orgId, p_agent: agent, p_subject_type: subjectType, p_subject: subjectId, p_rating: rating, p_correction: correction ?? {}, p_comment: comment || null, p_workflow: workflowId })
    setState(error ? 'error' : 'sent')
  }
  if (state === 'sent') return <Badge tone="ok">{t('aiFeedback.sent')}</Badge>
  return (
    <span className="inline-flex items-center gap-1">
      <button type="button" className="rounded p-1 text-muted hover:bg-surface-2 hover:text-ok" aria-label={t('aiFeedback.useful')} title={t('aiFeedback.useful')} onClick={() => void send(1)}><ThumbsUp className="size-3.5" aria-hidden /></button>
      <button type="button" className="rounded p-1 text-muted hover:bg-surface-2 hover:text-danger" aria-label={t('aiFeedback.wrong')} title={t('aiFeedback.wrong')} onClick={() => void send(-1)}><ThumbsDown className="size-3.5" aria-hidden /></button>
      {state === 'error' && <span className="text-xs text-danger">{t('aiFeedback.error')}</span>}
    </span>
  )
}

/** Validazione dei feedback in attesa (solo amministratori dell'organizzazione). */
export function FeedbackReviewPanel({ rows, onDone }: { rows: AiFeedbackRow[]; onDone: () => void }) {
  const { t, formatDate } = useI18n()
  const [busy, setBusy] = useState<string | null>(null)
  async function decide(id: string, decision: 'validate' | 'reject', asExample: boolean) {
    if (!supabase) return
    setBusy(id)
    await supabase.rpc('ai_feedback_review', { p_feedback: id, p_decision: decision, p_use_as_example: asExample })
    setBusy(null)
    onDone()
  }
  if (rows.length === 0) return <p className="text-sm text-muted">{t('aiFeedback.none')}</p>
  return (
    <ul className="divide-y divide-line text-sm">
      {rows.map((r) => (
        <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
          <span className="min-w-0">
            <Badge tone={r.rating > 0 ? 'ok' : 'danger'}>{r.rating > 0 ? t('aiFeedback.useful') : t('aiFeedback.wrong')}</Badge>{' '}
            <span className="text-xs text-muted">{t(`aiAgents.agents.${r.agent_key}.name`)} · {formatDate(r.created_at)}</span>
            {r.comment && <span className="block break-words">{r.comment}</span>}
          </span>
          <span className="flex flex-wrap gap-1.5">
            <Button size="sm" loading={busy === r.id} onClick={() => void decide(r.id, 'validate', true)}>{t('aiFeedback.validateExample')}</Button>
            <Button size="sm" variant="secondary" onClick={() => void decide(r.id, 'validate', false)}>{t('aiFeedback.validate')}</Button>
            <Button size="sm" variant="ghost" onClick={() => void decide(r.id, 'reject', false)}>{t('aiFeedback.reject')}</Button>
          </span>
        </li>
      ))}
    </ul>
  )
}
