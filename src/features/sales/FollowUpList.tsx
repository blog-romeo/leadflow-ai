import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { BellRing, Check, RotateCcw, Sparkles, X } from 'lucide-react'
import { useI18n } from '../../i18n'
import { supabase } from '../../lib/supabase'
import type { FollowUpKind, FollowUpTaskRow } from '../../lib/database.types'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { Field, Select } from '../../components/ui/Field'
import { EmptyState, ErrorState, InlineAlert, LoadingState } from '../../components/ui/States'
import { cn } from '../../lib/cn'
import { salesErrorMessage } from './errors'
import { startGeneration, useJob } from './jobs'
import { JobBanner } from './JobBanner'

type Row = FollowUpTaskRow & { lead?: { company_name: string; contact_status: string; status: string } | null }
const KINDS: FollowUpKind[] = ['check_in', 'second_contact', 'opportunity_review', 'custom']

function bucket(r: Row): 'overdue' | 'today' | 'upcoming' | 'blocked' | 'closed' {
  if (r.status === 'blocked') return 'blocked'
  if (r.status !== 'open') return 'closed'
  const due = new Date(r.due_at)
  const endOfToday = new Date()
  endOfToday.setHours(23, 59, 59, 999)
  if (due.getTime() < Date.now()) return 'overdue'
  if (due <= endOfToday) return 'today'
  return 'upcoming'
}

function TaskItem({ r, orgId, aiReady, showLead, onChanged, onNotice }: { r: Row; orgId: string; aiReady: boolean; showLead: boolean; onChanged: () => void; onNotice: (tone: 'ok' | 'danger', text: string) => void }) {
  const { t, formatDate } = useI18n()
  const [jobId, setJobId] = useState<string | null>(null)
  const { job, running } = useJob(jobId, () => onChanged())
  const b = bucket(r)

  async function setStatus(status: FollowUpTaskRow['status']) {
    if (!supabase) return
    const { error } = await supabase.from('follow_up_tasks').update({ status }).eq('id', r.id)
    if (error) onNotice('danger', salesErrorMessage(error, t))
    onChanged()
  }
  async function suggest() {
    try {
      const res = await startGeneration(orgId, { task: 'follow_up_suggestion', follow_up_task_id: r.id })
      setJobId(res.job_id)
    } catch (err) {
      onNotice('danger', salesErrorMessage(err, t))
    }
  }

  return (
    <li className={cn('rounded-[var(--radius-control)] border bg-surface p-3', b === 'overdue' ? 'border-danger/40' : 'border-line')}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium">{r.title}</p>
          <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted">
            <Badge tone={b === 'overdue' ? 'danger' : b === 'today' ? 'signal' : 'neutral'}>{t(`sales.followUps.kinds.${r.kind}`)}</Badge>
            <time dateTime={r.due_at}>{t('sales.followUps.dueOn', { date: formatDate(r.due_at) })}</time>
            {r.source === 'cadence' && <span>· {t('sales.followUps.cadence')}</span>}
            {showLead && r.lead && (
              <>
                {' · '}
                <Link to={`/app/sales-agent/leads/${r.lead_id}`} className="text-flow hover:underline">
                  {r.lead.company_name}
                </Link>
              </>
            )}
          </p>
          {r.status === 'blocked' && r.blocked_reason && (
            <p className="mt-1 text-xs text-danger">{t(`sales.followUps.blockedReasons.${r.blocked_reason}`)}</p>
          )}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {r.status === 'open' && (
            <>
              <Button size="sm" variant="secondary" onClick={() => void suggest()} disabled={!aiReady || running} loading={running}>
                <Sparkles className="size-4" aria-hidden />
                {t('sales.followUps.suggest')}
              </Button>
              <Button size="sm" onClick={() => void setStatus('done')}>
                <Check className="size-4" aria-hidden />
                {t('sales.followUps.complete')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void setStatus('dismissed')} aria-label={t('sales.followUps.dismiss')}>
                <X className="size-4" aria-hidden />
                <span className="hidden sm:inline">{t('sales.followUps.dismiss')}</span>
              </Button>
            </>
          )}
          {(r.status === 'done' || r.status === 'dismissed') && (
            <Button size="sm" variant="ghost" onClick={() => void setStatus('open')}>
              <RotateCcw className="size-4" aria-hidden />
              {t('sales.followUps.reopen')}
            </Button>
          )}
        </div>
      </div>
      <JobBanner job={job} />
      {r.ai_suggestion && (
        <dl className="mt-2 grid gap-1 rounded-[var(--radius-control)] bg-surface-2 p-2.5 text-sm">
          <div>
            <dt className="inline font-medium">{t('sales.followUps.suggestion')}: </dt>
            <dd className="inline">{r.ai_suggestion.suggestion}</dd>
          </div>
          <div>
            <dt className="inline font-medium">{t('sales.followUps.reasoning')}: </dt>
            <dd className="inline">{r.ai_suggestion.reasoning}</dd>
          </div>
          <div>
            <dt className="inline font-medium">{t('sales.followUps.timing')}: </dt>
            <dd className="inline">{r.ai_suggestion.timing_note}</dd>
          </div>
          {r.ai_suggestion.draft_id && <p className="text-xs text-ok">{t('sales.followUps.draftReady')}</p>}
        </dl>
      )}
    </li>
  )
}

export function FollowUpList({ orgId, leadId, aiReady, contactable = true, refreshKey = 0 }: { orgId: string; leadId?: string; aiReady: boolean; contactable?: boolean; refreshKey?: number }) {
  const { t } = useI18n()
  const [rows, setRows] = useState<Row[] | null>(null)
  const [error, setError] = useState(false)
  const [notice, setNotice] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null)
  const [form, setForm] = useState<{ title: string; kind: FollowUpKind; due: string } | null>(null)

  const load = useCallback(async () => {
    if (!supabase) return
    let q = supabase
      .from('follow_up_tasks')
      .select('*, lead:leads(company_name, contact_status, status)')
      .eq('organization_id', orgId)
      .order('due_at', { ascending: true })
      .limit(200)
    if (leadId) q = q.eq('lead_id', leadId)
    else q = q.in('status', ['open', 'blocked'])
    const { data, error: e } = await q
    setError(!!e)
    setRows((data ?? []) as unknown as Row[])
  }, [orgId, leadId])

  useEffect(() => {
    void load()
  }, [load, refreshKey])

  async function create(e: FormEvent) {
    e.preventDefault()
    if (!supabase || !form || !leadId || form.title.trim().length < 2 || !form.due) return
    const { error: err } = await supabase.from('follow_up_tasks').insert({
      organization_id: orgId,
      lead_id: leadId,
      kind: form.kind,
      title: form.title.trim(),
      due_at: new Date(form.due).toISOString(),
    })
    if (err) return setNotice({ tone: 'danger', text: salesErrorMessage(err, t) })
    setForm(null)
    setNotice({ tone: 'ok', text: t('sales.followUps.created') })
    void load()
  }

  const groups = (['overdue', 'today', 'upcoming', 'blocked', 'closed'] as const).map((g) => ({ g, items: (rows ?? []).filter((r) => bucket(r) === g) }))

  return (
    <div className="space-y-4">
      {leadId && (
        <div className="flex flex-wrap items-center gap-2">
          {!form ? (
            <Button size="sm" variant="secondary" onClick={() => setForm({ title: '', kind: contactable ? 'custom' : 'opportunity_review', due: '' })}>
              <BellRing className="size-4" aria-hidden />
              {t('sales.followUps.create')}
            </Button>
          ) : (
            <form onSubmit={create} className="grid w-full gap-3 rounded-[var(--radius-panel)] border border-line bg-surface p-4 sm:grid-cols-[1fr_12rem_12rem_auto] sm:items-end">
              <Field label={t('sales.followUps.name')} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} maxLength={200} required />
              <Select label={t('sales.followUps.kind')} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as FollowUpKind })}>
                {KINDS.map((k) => (
                  <option key={k} value={k} disabled={!contactable && k !== 'opportunity_review'}>
                    {t(`sales.followUps.kinds.${k}`)}
                  </option>
                ))}
              </Select>
              <Field label={t('sales.followUps.due')} type="datetime-local" value={form.due} onChange={(e) => setForm({ ...form, due: e.target.value })} required />
              <div className="flex gap-2">
                <Button type="submit" size="md">
                  {t('common.save')}
                </Button>
                <Button variant="ghost" onClick={() => setForm(null)}>
                  {t('common.cancel')}
                </Button>
              </div>
            </form>
          )}
        </div>
      )}
      {notice && <InlineAlert tone={notice.tone}>{notice.text}</InlineAlert>}
      {error ? (
        <ErrorState message={t('sales.errors.generic')} onRetry={() => void load()} />
      ) : !rows ? (
        <LoadingState />
      ) : rows.length === 0 ? (
        <EmptyState icon={BellRing} title={t('sales.followUps.empty')} className="rounded-[var(--radius-panel)] border border-dashed border-line" />
      ) : (
        groups
          .filter(({ items }) => items.length > 0)
          .map(({ g, items }) => (
            <section key={g} aria-label={g === 'closed' ? t('sales.followUps.complete') : t(`sales.followUps.${g}`)}>
              <h4 className="mb-2 text-sm font-semibold">
                {g === 'closed' ? `${t('sales.followUps.complete')} / ${t('sales.followUps.dismiss')}` : t(`sales.followUps.${g}`)} <span className="text-muted">({items.length})</span>
              </h4>
              <ul className="space-y-2">
                {items.map((r) => (
                  <TaskItem key={r.id} r={r} orgId={orgId} aiReady={aiReady} showLead={!leadId} onChanged={() => void load()} onNotice={(tone, text) => setNotice({ tone, text })} />
                ))}
              </ul>
            </section>
          ))
      )}
    </div>
  )
}
