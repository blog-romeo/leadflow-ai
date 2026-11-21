import { useState } from 'react'
import { ShieldCheck } from 'lucide-react'
import { useI18n } from '../../i18n'
import type { AiAgentApprovalRow } from '../../lib/database.types'
import { Button } from '../../components/ui/Button'
import { InlineAlert } from '../../components/ui/States'
import { actionKey, aiErrorMessage, controlWorkflow } from './shared'

interface Summary {
  candidates?: { candidate_id: string; company_name: string | null; score: number; priority: string; in_crm: boolean }[]
  new_leads?: number
  estimated_strategy_credits?: number
  estimated_credits?: number
  create?: { lead_id: string; kind: string; title: string }[]
  block?: { task_id: string; company_name: string }[]
  drafts?: number
}

/** Richiesta di approvazione di un'operazione ad alto impatto: cosa accadrà, esattamente, se approvata. */
export function ApprovalCard({ approval, orgId, isAdmin, onDone }: { approval: AiAgentApprovalRow; orgId: string; isAdmin: boolean; onDone: () => void }) {
  const { t, formatDate } = useI18n()
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const s = (approval.summary ?? {}) as Summary

  async function decide(d: 'approve' | 'reject') {
    setBusy(d)
    setErr(null)
    try {
      await controlWorkflow(orgId, approval.workflow_id, d, approval.id)
      onDone()
    } catch (e) {
      setErr(aiErrorMessage(e, t))
    } finally {
      setBusy(null)
    }
  }

  return (
    <article className="rounded-[var(--radius-control)] border border-signal/40 bg-signal-soft/40 p-4">
      <div className="flex items-start gap-3">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-signal" aria-hidden />
        <div className="min-w-0 flex-1 space-y-2 text-sm">
          <p className="font-semibold">{t(`aiAgents.approvals.action.${actionKey(approval.action)}`)}</p>
          {s.candidates && (
            <div>
              <p className="text-xs font-medium text-muted">{t('aiAgents.approvals.candidates')}</p>
              <ul className="mt-1 space-y-0.5">
                {s.candidates.map((c) => (
                  <li key={c.candidate_id} className="flex justify-between gap-3">
                    <span className="truncate">{c.company_name ?? '—'}</span>
                    <span className="shrink-0 tabular-nums text-muted">{c.score}/100</span>
                  </li>
                ))}
              </ul>
              {typeof s.new_leads === 'number' && <p className="mt-1 text-xs text-muted">{t('aiAgents.approvals.newLeads', { count: s.new_leads })}</p>}
            </div>
          )}
          {s.create && <p>{t('aiAgents.approvals.create', { count: s.create.length })}</p>}
          {s.block && s.block.length > 0 && <p>{t('aiAgents.approvals.block', { count: s.block.length })}</p>}
          {typeof s.drafts === 'number' && s.drafts > 0 && <p>{t('aiAgents.approvals.drafts', { count: s.drafts })}</p>}
          {(s.estimated_strategy_credits ?? s.estimated_credits ?? 0) > 0 && <p>{t('aiAgents.approvals.estimatedCredits', { credits: s.estimated_strategy_credits ?? s.estimated_credits ?? 0 })}</p>}
          <p className="text-xs text-muted">
            {t('aiAgents.approvals.noSend')} · {t('aiAgents.approvals.expires', { date: formatDate(approval.expires_at) })}
          </p>
          {err && <InlineAlert>{err}</InlineAlert>}
          {isAdmin ? (
            <div className="flex flex-wrap gap-2 pt-1">
              <Button size="sm" loading={busy === 'approve'} disabled={!!busy} onClick={() => void decide('approve')}>
                {t('aiAgents.approvals.approve')}
              </Button>
              <Button size="sm" variant="secondary" loading={busy === 'reject'} disabled={!!busy} onClick={() => void decide('reject')}>
                {t('aiAgents.approvals.reject')}
              </Button>
            </div>
          ) : (
            <p className="text-xs text-muted">{t('aiAgents.approvals.adminOnly')}</p>
          )}
        </div>
      </div>
    </article>
  )
}
