import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { useI18n } from '../../i18n'
import { supabase } from '../../lib/supabase'
import {
  AUTOMATION_TRIGGERS,
  PIPELINE_STAGES,
  WORKFLOW_ACTIONS,
  type AutomationJobRow,
  type AutomationTrigger,
  type AutomationWorkflowRow,
  type CampaignRow,
  type Json,
  type NotificationRow,
  type WorkflowAction,
  type WorkflowActionType,
} from '../../lib/database.types'
import { PageHeader } from '../../components/ui/PageHeader'
import { Panel } from '../../components/ui/Panel'
import { Field, Select } from '../../components/ui/Field'
import { Button } from '../../components/ui/Button'
import { Badge } from '../../components/ui/Badge'
import { Dialog } from '../../components/ui/Dialog'
import { EmptyState, InlineAlert, LoadingState } from '../../components/ui/States'
import { Check, cmError } from '../../features/campaigns/shared'
import { Workflow } from 'lucide-react'

type Draft = {
  id: string | null
  name: string
  trigger: AutomationTrigger
  min_score: string
  industry: string
  campaign_id: string
  actions: Partial<Record<WorkflowActionType, WorkflowAction>>
}
const empty = (): Draft => ({ id: null, name: '', trigger: 'lead_qualified', min_score: '', industry: '', campaign_id: '', actions: {} })

function Editor({ orgId, draft, campaigns, onClose, onSaved }: { orgId: string; draft: Draft; campaigns: Pick<CampaignRow, 'id' | 'name'>[]; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n()
  const [d, setD] = useState(draft)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const toggle = (a: WorkflowActionType, on: boolean) =>
    setD((x) => {
      const actions = { ...x.actions }
      if (on) actions[a] = { type: a, ...(a === 'create_reminder' || a === 'prepare_follow_up' ? { days: a === 'prepare_follow_up' ? 3 : 1 } : {}), ...(a === 'update_lead_status' ? { status: 'to_contact' } : {}), ...(a === 'generate_draft' ? { channel: 'email' } : {}) }
      else delete actions[a]
      return { ...x, actions }
    })
  const patch = (a: WorkflowActionType, p: Partial<WorkflowAction>) => setD((x) => ({ ...x, actions: { ...x.actions, [a]: { ...x.actions[a]!, ...p } } }))

  async function save(e: FormEvent) {
    e.preventDefault()
    if (!supabase) return
    const actions = Object.values(d.actions).filter(Boolean) as WorkflowAction[]
    const conditions: Record<string, unknown> = {}
    if (d.min_score.trim()) conditions.min_score = Number(d.min_score)
    if (d.industry.trim()) conditions.industry = d.industry.trim()
    if (d.campaign_id) conditions.campaign_id = d.campaign_id
    const row = { name: d.name.trim(), trigger: d.trigger, conditions: conditions as Json, actions: actions as unknown as Json }
    setBusy(true)
    const res = d.id
      ? await supabase.from('automation_workflows').update(row as never).eq('id', d.id)
      : await supabase.from('automation_workflows').insert({ organization_id: orgId, ...row } as never)
    setBusy(false)
    if (res.error) return setMsg(cmError(res.error, t))
    onSaved()
  }

  return (
    <Dialog open onClose={onClose} title={d.id ? t('automations.edit') : t('automations.new')} closeLabel={t('common.close')} variant="drawer">
      <form onSubmit={(e) => void save(e)} className="space-y-4">
        <Field label={t('automations.name')} value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} maxLength={120} required />
        <Select label={t('automations.trigger')} value={d.trigger} onChange={(e) => setD({ ...d, trigger: e.target.value as AutomationTrigger })}>
          {AUTOMATION_TRIGGERS.map((tr) => (
            <option key={tr} value={tr}>
              {t(`automations.triggers.${tr}`)}
            </option>
          ))}
        </Select>
        <fieldset className="space-y-3 rounded-[var(--radius-panel)] border border-line p-3">
          <legend className="px-1 text-sm font-medium">{t('automations.conditions')}</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field type="number" min={0} max={100} label={t('automations.minScore')} value={d.min_score} onChange={(e) => setD({ ...d, min_score: e.target.value })} />
            <Field label={t('automations.industry')} value={d.industry} onChange={(e) => setD({ ...d, industry: e.target.value })} maxLength={80} />
          </div>
          <Select label={t('automations.campaign')} value={d.campaign_id} onChange={(e) => setD({ ...d, campaign_id: e.target.value })}>
            <option value="">{t('automations.anyCampaign')}</option>
            {campaigns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </fieldset>
        <fieldset className="space-y-3 rounded-[var(--radius-panel)] border border-line p-3">
          <legend className="px-1 text-sm font-medium">{t('automations.actions')}</legend>
          {WORKFLOW_ACTIONS.map((a) => {
            const on = !!d.actions[a]
            return (
              <div key={a} className="space-y-2">
                <Check id={`act-${a}`} label={t(`automations.actionTypes.${a}`)} checked={on} onChange={(v) => toggle(a, v)} />
                {on && (a === 'create_reminder' || a === 'prepare_follow_up') && (
                  <Field className="ml-6 max-w-40" type="number" min={0} max={90} label={t('automations.days')} value={String(d.actions[a]?.days ?? 1)} onChange={(e) => patch(a, { days: Number(e.target.value) })} />
                )}
                {on && a === 'update_lead_status' && (
                  <Select className="ml-6" label={t('automations.status')} value={d.actions[a]?.status ?? 'to_contact'} onChange={(e) => patch(a, { status: e.target.value })}>
                    {PIPELINE_STAGES.filter((s) => s !== 'won' && s !== 'lost').map((s) => (
                      <option key={s} value={s}>
                        {t(`status.${s}`)}
                      </option>
                    ))}
                  </Select>
                )}
                {on && a === 'notify' && <Field className="ml-6" label={t('automations.notifyTitle')} value={d.actions[a]?.title ?? ''} onChange={(e) => patch(a, { title: e.target.value })} maxLength={150} />}
                {on && a === 'generate_draft' && (
                  <Select className="ml-6" label={t('automations.draftChannel')} value={d.actions[a]?.channel ?? 'email'} onChange={(e) => patch(a, { channel: e.target.value })}>
                    {['email', 'linkedin', 'whatsapp', 'phone_script', 'follow_up'].map((c) => (
                      <option key={c} value={c}>
                        {t(`sales.messages.channels.${c}`)}
                      </option>
                    ))}
                  </Select>
                )}
              </div>
            )
          })}
        </fieldset>
        {d.id && <p className="text-xs text-muted">{t('automations.editResets')}</p>}
        {msg && <InlineAlert>{msg}</InlineAlert>}
        <Button type="submit" loading={busy} disabled={d.name.trim().length < 2 || Object.keys(d.actions).length === 0}>
          {t('automations.save')}
        </Button>
      </form>
    </Dialog>
  )
}

export default function Automations() {
  const { t, formatDate, formatNumber } = useI18n()
  const { currentOrg, isOrgAdmin, user } = useAuth()
  const orgId = currentOrg?.id ?? ''
  const [rows, setRows] = useState<AutomationWorkflowRow[] | null>(null)
  const [campaigns, setCampaigns] = useState<Pick<CampaignRow, 'id' | 'name'>[]>([])
  const [queue, setQueue] = useState<Record<string, number>>({})
  const [dead, setDead] = useState<AutomationJobRow[]>([])
  const [notes, setNotes] = useState<NotificationRow[]>([])
  const [editing, setEditing] = useState<Draft | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!supabase || !orgId) return
    const db = supabase
    const statuses = ['queued', 'running', 'succeeded', 'dead', 'cancelled'] as const
    const [wf, camps, deadJobs, notif, ...counts] = await Promise.all([
      db.from('automation_workflows').select('*').eq('organization_id', orgId).order('created_at', { ascending: false }),
      db.from('campaigns').select('id, name').eq('organization_id', orgId).order('created_at', { ascending: false }).limit(200),
      db.from('automation_jobs').select('*').eq('organization_id', orgId).eq('status', 'dead').order('updated_at', { ascending: false }).limit(15),
      db.from('notifications').select('*').eq('organization_id', orgId).order('created_at', { ascending: false }).limit(20),
      ...statuses.map((s) => db.from('automation_jobs').select('id', { count: 'exact', head: true }).eq('organization_id', orgId).eq('status', s)),
    ])
    setRows((wf.data ?? []) as unknown as AutomationWorkflowRow[])
    setCampaigns((camps.data ?? []) as Pick<CampaignRow, 'id' | 'name'>[])
    setDead((deadJobs.data ?? []) as AutomationJobRow[])
    setNotes((notif.data ?? []) as NotificationRow[])
    setQueue(Object.fromEntries(statuses.map((s, i) => [s, (counts[i] as { count: number | null }).count ?? 0])))
  }, [orgId])
  useEffect(() => {
    void load()
  }, [load])

  async function setStatus(id: string, status: string) {
    if (!supabase) return
    const { error } = await supabase.from('automation_workflows').update({ status } as never).eq('id', id)
    setMsg(error ? cmError(error, t) : null)
    void load()
  }
  async function remove(id: string) {
    if (!supabase) return
    const { error } = await supabase.from('automation_workflows').delete().eq('id', id)
    setMsg(error ? cmError(error, t) : null)
    void load()
  }
  async function markRead(id: string) {
    if (!supabase) return
    await supabase.from('notifications').update({ read_at: new Date().toISOString() }).eq('id', id)
    void load()
  }
  const toDraft = (w: AutomationWorkflowRow): Draft => ({
    id: w.id,
    name: w.name,
    trigger: w.trigger,
    min_score: w.conditions.min_score != null ? String(w.conditions.min_score) : '',
    industry: w.conditions.industry ?? '',
    campaign_id: w.conditions.campaign_id ?? '',
    actions: Object.fromEntries(w.actions.map((a) => [a.type, a])),
  })

  return (
    <>
      <PageHeader
        title={t('automations.title')}
        subtitle={t('automations.subtitle')}
        actions={
          <Button onClick={() => setEditing(empty())}>
            <Plus className="size-4" aria-hidden />
            {t('automations.new')}
          </Button>
        }
      />
      <div className="space-y-5">
        {msg && <InlineAlert>{msg}</InlineAlert>}
        {rows === null ? (
          <LoadingState />
        ) : rows.length === 0 ? (
          <EmptyState icon={Workflow} title={t('automations.empty')} />
        ) : (
          <ul className="space-y-3">
            {rows.map((w) => (
              <li key={w.id} className="rounded-[var(--radius-panel)] border border-line bg-surface p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h2 className="font-semibold break-words">{w.name}</h2>
                    <p className="text-sm text-muted">
                      {t('automations.trigger')}: {t(`automations.triggers.${w.trigger}`)} → {w.actions.map((a) => t(`automations.actionTypes.${a.type}`)).join(', ')}
                    </p>
                    <p className="mt-1 text-xs text-muted">
                      {t('automations.runs')}: {formatNumber(w.run_count)}
                      {w.last_run_at ? ` · ${t('automations.lastRun')}: ${formatDate(w.last_run_at)}` : ''}
                    </p>
                    {w.last_error && <p className="text-xs text-danger">{t('automations.lastError')}: {w.last_error}</p>}
                  </div>
                  <Badge tone={w.status === 'running' ? 'ok' : w.status === 'pending_approval' || w.status === 'paused' ? 'signal' : 'neutral'}>{t(`automations.statusLabels.${w.status}`)}</Badge>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button size="sm" variant="ghost" onClick={() => setEditing(toDraft(w))}>
                    <Pencil className="size-4" aria-hidden />
                    {t('automations.edit')}
                  </Button>
                  {w.status === 'draft' && (
                    <Button size="sm" variant="secondary" onClick={() => void setStatus(w.id, 'pending_approval')}>
                      {t('automations.submit')}
                    </Button>
                  )}
                  {(w.status === 'pending_approval' || w.status === 'paused' || w.status === 'draft') && isOrgAdmin && (
                    <Button size="sm" onClick={() => void setStatus(w.id, 'running')}>
                      {t('automations.activate')}
                    </Button>
                  )}
                  {w.status === 'running' && (
                    <Button size="sm" variant="secondary" onClick={() => void setStatus(w.id, 'paused')}>
                      {t('automations.pause')}
                    </Button>
                  )}
                  {w.status !== 'cancelled' && (
                    <Button size="sm" variant="ghost" onClick={() => void setStatus(w.id, 'cancelled')}>
                      {t('automations.cancel')}
                    </Button>
                  )}
                  {isOrgAdmin && (
                    <Button size="sm" variant="ghost" onClick={() => void remove(w.id)} aria-label={`${t('automations.delete')} ${w.name}`}>
                      <Trash2 className="size-4" aria-hidden />
                    </Button>
                  )}
                </div>
                {!isOrgAdmin && w.status === 'pending_approval' && <p className="mt-2 text-xs text-muted">{t('automations.adminOnly')}</p>}
              </li>
            ))}
          </ul>
        )}
        <div className="grid gap-5 lg:grid-cols-2">
          <Panel title={t('automations.queue')}>
            <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
              {Object.entries(queue).map(([k, v]) => (
                <div key={k} className="rounded-[var(--radius-control)] bg-surface-2 px-3 py-2">
                  <dt className="text-xs text-muted">{t(`automations.queueStatus.${k}`)}</dt>
                  <dd className="tabular font-semibold">{formatNumber(v)}</dd>
                </div>
              ))}
            </dl>
            <h3 className="mt-4 mb-1 text-sm font-semibold">{t('automations.deadTitle')}</h3>
            {dead.length === 0 ? (
              <p className="text-sm text-muted">{t('automations.noDead')}</p>
            ) : (
              <ul className="space-y-1 text-xs">
                {dead.map((j) => (
                  <li key={j.id} className="flex flex-wrap justify-between gap-2 border-b border-line/60 pb-1">
                    <span className="font-mono">{j.kind}</span>
                    <span className="text-danger">{j.last_error}</span>
                    <span className="text-muted">{formatDate(j.updated_at)}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-3 text-xs text-muted">{t('automations.workerNote')}</p>
          </Panel>
          <Panel title={t('automations.notifications')}>
            {notes.length === 0 ? (
              <p className="text-sm text-muted">{t('automations.noNotifications')}</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {notes.map((n) => (
                  <li key={n.id} className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className={n.read_at ? 'text-muted' : 'font-medium'}>{n.title}</p>
                      <p className="text-xs text-muted">
                        {n.body ? `${n.body} · ` : ''}
                        {formatDate(n.created_at)}
                      </p>
                    </div>
                    {!n.read_at && n.user_id === user?.id && (
                      <Button size="sm" variant="ghost" onClick={() => void markRead(n.id)}>
                        {t('automations.markRead')}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>
      {editing && (
        <Editor
          orgId={orgId}
          draft={editing}
          campaigns={campaigns}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            void load()
          }}
        />
      )}
    </>
  )
}
