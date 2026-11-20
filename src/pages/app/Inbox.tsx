import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { ArrowLeft, Bot, CalendarPlus, ExternalLink, Inbox as InboxIcon, Send } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { useI18n } from '../../i18n'
import { supabase } from '../../lib/supabase'
import { apiFetch } from '../../lib/api'
import { INBOUND_CLASSES, PIPELINE_STAGES, type CampaignRow, type InboundClass, type InboundMessageRow, type OutboundMessageRow } from '../../lib/database.types'
import { PageHeader } from '../../components/ui/PageHeader'
import { Panel } from '../../components/ui/Panel'
import { Field, Select } from '../../components/ui/Field'
import { Button } from '../../components/ui/Button'
import { Badge } from '../../components/ui/Badge'
import { EmptyState, InlineAlert, LoadingState } from '../../components/ui/States'
import { cn } from '../../lib/cn'
import { useJob } from '../../features/sales/jobs'
import { JobBanner } from '../../features/sales/JobBanner'
import { Check, cmError, TextArea, useAccounts } from '../../features/campaigns/shared'

type InboundView = InboundMessageRow & {
  lead: { id: string; company_name: string; status: string; contact_status: string } | null
  recipient: { campaign_id: string } | null
}

const CLASS_TONE: Record<InboundClass, 'neutral' | 'flow' | 'signal' | 'danger' | 'ok'> = {
  positive: 'ok',
  question: 'flow',
  neutral: 'neutral',
  not_interested: 'neutral',
  unsubscribe: 'danger',
  out_of_office: 'neutral',
  needs_human: 'signal',
  other: 'neutral',
}

function Detail({ item, onChanged, canSend }: { item: InboundView; onChanged: () => void; canSend: boolean }) {
  const { t, formatDate } = useI18n()
  const [thread, setThread] = useState<{ dir: 'in' | 'out'; at: string; subject: string; body: string; id: string }[]>([])
  const [subject, setSubject] = useState((/^re:/i.test(item.subject ?? '') ? (item.subject ?? '') : `Re: ${item.subject ?? ''}`).slice(0, 200))
  const [body, setBody] = useState('')
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [jobId, setJobId] = useState<string | null>(null)
  const { job } = useJob(jobId, () => onChanged())

  useEffect(() => {
    setSubject((/^re:/i.test(item.subject ?? '') ? (item.subject ?? '') : `Re: ${item.subject ?? ''}`).slice(0, 200))
    setBody('')
    setConfirm(false)
    setMsg(null)
    if (!supabase) return
    const db = supabase
    const leadId = item.lead_id
    void (async () => {
      const [ins, outs] = await Promise.all([
        leadId ? db.from('inbound_messages').select('id, subject, body_text, received_at').eq('lead_id', leadId).order('received_at').limit(50) : Promise.resolve({ data: [{ id: item.id, subject: item.subject, body_text: item.body_text, received_at: item.received_at }] }),
        leadId ? db.from('outbound_messages').select('id, subject, body_text, sent_at, created_at, status, kind').eq('lead_id', leadId).neq('kind', 'test').order('created_at').limit(50) : Promise.resolve({ data: [] }),
      ])
      const list = [
        ...((ins.data ?? []) as { id: string; subject: string | null; body_text: string | null; received_at: string }[]).map((m) => ({ dir: 'in' as const, at: m.received_at, subject: m.subject ?? '', body: m.body_text ?? '', id: m.id })),
        ...((outs.data ?? []) as (Pick<OutboundMessageRow, 'id' | 'subject' | 'body_text' | 'sent_at' | 'created_at' | 'status'>)[])
          .filter((m) => ['sent', 'delivered', 'delivery_delayed', 'bounced', 'complained'].includes(m.status))
          .map((m) => ({ dir: 'out' as const, at: m.sent_at ?? m.created_at, subject: m.subject, body: m.body_text, id: m.id })),
      ].sort((a, b) => a.at.localeCompare(b.at))
      setThread(list)
    })()
  }, [item])

  async function setClass(value: string) {
    if (!supabase) return
    const { error } = await supabase.from('inbound_messages').update({ classification: (value || null) as InboundClass | null }).eq('id', item.id)
    setMsg(error ? { ok: false, text: cmError(error, t) } : null)
    onChanged()
  }
  async function markHandled() {
    if (!supabase) return
    await supabase.from('inbound_messages').update({ handled_at: item.handled_at ? null : new Date().toISOString() }).eq('id', item.id)
    onChanged()
  }
  async function analyze() {
    setBusy('analyze')
    try {
      const r = await apiFetch<{ job_id: string }>('/api/inbox/actions', { method: 'POST', body: { action: 'analyze', organization_id: item.organization_id, inbound_id: item.id } })
      setJobId(r.job_id)
    } catch (err) {
      setMsg({ ok: false, text: cmError(err, t) })
    } finally {
      setBusy(null)
    }
  }
  async function createTask() {
    if (!supabase || !item.lead_id) return
    const due = new Date(Date.now() + 86_400_000).toISOString()
    const { error } = await supabase.from('follow_up_tasks').insert({ organization_id: item.organization_id, lead_id: item.lead_id, kind: 'custom', title: `${t('inbox.reply')}: ${item.subject ?? item.from_email}`.slice(0, 200), notes: item.ai_summary, due_at: due })
    setMsg(error ? { ok: false, text: cmError(error, t) } : { ok: true, text: t('inbox.taskCreated') })
  }
  async function send() {
    setBusy('send')
    setMsg(null)
    try {
      await apiFetch('/api/inbox/actions', { method: 'POST', body: { action: 'reply', organization_id: item.organization_id, inbound_id: item.id, subject: subject.trim(), body: body.trim(), confirm: true } })
      setMsg({ ok: true, text: t('inbox.replyQueued') })
      setConfirm(false)
      onChanged()
    } catch (err) {
      setMsg({ ok: false, text: cmError(err, t) })
    } finally {
      setBusy(null)
    }
  }

  const blocked = !!item.lead && item.lead.contact_status !== 'active'
  const effective = item.classification ?? item.ai_classification
  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold break-words">{item.subject || '—'}</h2>
          <p className="text-sm text-muted break-words">
            {item.lead?.company_name ?? t('inbox.unknownSender')} · {item.from_email} · {formatDate(item.received_at)}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {item.lead && (
            <Link to={`/app/sales-agent/leads/${item.lead.id}?tab=timeline`} className="inline-flex items-center gap-1 text-sm text-flow hover:underline">
              {t('inbox.openCrm')} <ExternalLink className="size-3.5" aria-hidden />
            </Link>
          )}
        </div>
      </header>

      <section className="space-y-2 rounded-[var(--radius-panel)] border border-line p-4">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          <Bot className="size-4 text-flow" aria-hidden />
          {t('inbox.aiSummary')}
        </h3>
        {item.ai_summary ? <p className="text-sm">{item.ai_summary}</p> : <p className="text-sm text-muted">{t('inbox.aiPending')}</p>}
        {item.ai_needs_human && <Badge tone="signal">{t('inbox.needsHuman')}</Badge>}
        <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
          <Select label={t('inbox.confirmClass')} value={item.classification ?? ''} onChange={(e) => void setClass(e.target.value)}>
            <option value="">{item.ai_classification ? t('inbox.aiSuggests', { value: t(`inbox.classes.${item.ai_classification}`) }) : '—'}</option>
            {INBOUND_CLASSES.map((c) => (
              <option key={c} value={c}>
                {t(`inbox.classes.${c}`)}
              </option>
            ))}
          </Select>
          <Button variant="secondary" size="md" loading={busy === 'analyze'} onClick={() => void analyze()}>
            {item.ai_summary ? t('inbox.reanalyze') : t('inbox.analyze')}
          </Button>
        </div>
        {item.classification && <p className="text-xs text-muted">{t('inbox.confirmed')}</p>}
        {effective === 'unsubscribe' && <p className="text-xs text-danger">{t('inbox.unsubscribeNote')}</p>}
        <JobBanner job={job} />
      </section>

      <section>
        <h3 className="mb-2 text-sm font-semibold">{t('inbox.thread')}</h3>
        <ol className="space-y-3">
          {thread.map((m) => (
            <li key={`${m.dir}-${m.id}`} className={cn('rounded-[var(--radius-panel)] p-3 text-sm', m.dir === 'in' ? 'mr-6 border border-line bg-surface' : 'ml-6 bg-flow-soft')}>
              <p className="mb-1 text-xs text-muted">
                {m.dir === 'in' ? t('inbox.received') : t('inbox.sent')} · {formatDate(m.at)}
              </p>
              <p className="font-medium break-words">{m.subject}</p>
              <p className="mt-1 max-h-60 overflow-y-auto whitespace-pre-wrap break-words text-ink/85">{m.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="space-y-3 rounded-[var(--radius-panel)] border border-line p-4">
        <h3 className="text-sm font-semibold">{t('inbox.reply')}</h3>
        {!item.lead_id ? (
          <p className="text-sm text-muted">{t('inbox.replyNoLead')}</p>
        ) : blocked ? (
          <p className="text-sm text-danger">{t('inbox.replyBlocked')}</p>
        ) : !canSend ? (
          <p className="text-sm text-muted">{t('inbox.replyNoProvider')}</p>
        ) : (
          <>
            {item.ai_suggested_reply && (
              <Button size="sm" variant="ghost" onClick={() => setBody(item.ai_suggested_reply ?? '')}>
                {t('inbox.replyUseSuggestion')}
              </Button>
            )}
            <Field label={t('inbox.replySubject')} value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} />
            <TextArea id="reply-body" label={t('inbox.replyBody')} value={body} onChange={setBody} rows={7} />
            <Check id="reply-confirm" label={t('inbox.replyConfirm')} checked={confirm} onChange={setConfirm} />
            <Button onClick={() => void send()} loading={busy === 'send'} disabled={!confirm || body.trim().length < 2 || !subject.trim()}>
              <Send className="size-4" aria-hidden />
              {t('inbox.replySend')}
            </Button>
          </>
        )}
      </section>
      <div className="flex flex-wrap gap-2">
        {item.lead_id && (
          <Button variant="secondary" onClick={() => void createTask()}>
            <CalendarPlus className="size-4" aria-hidden />
            {t('inbox.createTask')}
          </Button>
        )}
        <Button variant="ghost" onClick={() => void markHandled()}>
          {item.handled_at ? t('inbox.handled') : t('inbox.markHandled')}
        </Button>
      </div>
      <div aria-live="polite" className="empty:hidden">
        {msg && <InlineAlert tone={msg.ok ? 'ok' : 'danger'}>{msg.text}</InlineAlert>}
      </div>
    </div>
  )
}

export default function Inbox() {
  const { t, formatDate } = useI18n()
  const { currentOrg } = useAuth()
  const orgId = currentOrg?.id ?? ''
  const [params, setParams] = useSearchParams()
  const selectedId = params.get('id')
  const { accounts, connected } = useAccounts(orgId)
  const [items, setItems] = useState<InboundView[] | null>(null)
  const [campaigns, setCampaigns] = useState<Pick<CampaignRow, 'id' | 'name'>[]>([])
  const [filter, setFilter] = useState({ campaign: '', classification: '', leadStatus: '', open: false })

  const load = useCallback(async () => {
    if (!supabase || !orgId) return
    const [inb, camps] = await Promise.all([
      supabase
        .from('inbound_messages')
        .select('*, lead:leads(id, company_name, status, contact_status), recipient:campaign_recipients(campaign_id)')
        .eq('organization_id', orgId)
        .order('received_at', { ascending: false })
        .limit(200),
      supabase.from('campaigns').select('id, name').eq('organization_id', orgId).order('created_at', { ascending: false }).limit(200),
    ])
    const one = <T,>(x: T | T[] | null): T | null => (Array.isArray(x) ? (x[0] ?? null) : x)
    setItems(((inb.data ?? []) as unknown as (InboundView & { lead: unknown; recipient: unknown })[]).map((r) => ({ ...r, lead: one(r.lead as InboundView['lead']), recipient: one(r.recipient as InboundView['recipient']) })))
    setCampaigns((camps.data ?? []) as Pick<CampaignRow, 'id' | 'name'>[])
  }, [orgId])
  useEffect(() => {
    void load()
  }, [load])

  const filtered = useMemo(
    () =>
      (items ?? []).filter(
        (i) =>
          (!filter.campaign || i.recipient?.campaign_id === filter.campaign) &&
          (!filter.classification || (i.classification ?? i.ai_classification) === filter.classification) &&
          (!filter.leadStatus || i.lead?.status === filter.leadStatus) &&
          (!filter.open || !i.handled_at),
      ),
    [items, filter],
  )
  const selected = filtered.find((i) => i.id === selectedId) ?? (items ?? []).find((i) => i.id === selectedId) ?? null
  const noProvider = accounts !== null && accounts.length === 0

  return (
    <>
      <PageHeader title={t('inbox.title')} subtitle={t('inbox.subtitle')} />
      <div className="space-y-4">
        {noProvider && <InlineAlert tone="signal">{t('inbox.noProvider')}</InlineAlert>}
        {accounts && accounts.some((a) => a.status === 'connected' && !a.webhook_configured) && <InlineAlert tone="signal">{t('inbox.noWebhook')}</InlineAlert>}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Select label={t('inbox.filters.campaign')} value={filter.campaign} onChange={(e) => setFilter({ ...filter, campaign: e.target.value })}>
            <option value="">{t('inbox.filters.all')}</option>
            {campaigns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
          <Select label={t('inbox.filters.classification')} value={filter.classification} onChange={(e) => setFilter({ ...filter, classification: e.target.value })}>
            <option value="">{t('inbox.filters.all')}</option>
            {INBOUND_CLASSES.map((c) => (
              <option key={c} value={c}>
                {t(`inbox.classes.${c}`)}
              </option>
            ))}
          </Select>
          <Select label={t('inbox.filters.leadStatus')} value={filter.leadStatus} onChange={(e) => setFilter({ ...filter, leadStatus: e.target.value })}>
            <option value="">{t('inbox.filters.allStatuses')}</option>
            {PIPELINE_STAGES.map((s) => (
              <option key={s} value={s}>
                {t(`status.${s}`)}
              </option>
            ))}
          </Select>
          <div className="flex items-end pb-2">
            <Check id="inbox-open" label={t('inbox.filters.onlyOpen')} checked={filter.open} onChange={(v) => setFilter({ ...filter, open: v })} />
          </div>
        </div>
        {items === null ? (
          <LoadingState />
        ) : filtered.length === 0 && !selected ? (
          <EmptyState icon={InboxIcon} title={noProvider ? t('inbox.noProvider') : t('inbox.empty')} />
        ) : (
          <div className="grid gap-4 lg:grid-cols-[22rem_1fr]">
            <ul className={cn('space-y-1.5', selected && 'hidden lg:block')} aria-label={t('inbox.title')}>
              {filtered.map((i) => {
                const cls = i.classification ?? i.ai_classification
                return (
                  <li key={i.id}>
                    <button
                      type="button"
                      onClick={() => setParams({ id: i.id })}
                      aria-current={i.id === selectedId ? 'true' : undefined}
                      className={cn('w-full rounded-[var(--radius-panel)] border px-3 py-2.5 text-left text-sm', i.id === selectedId ? 'border-flow bg-flow-soft' : 'border-line bg-surface hover:bg-surface-2')}
                    >
                      <span className="flex items-center justify-between gap-2">
                        <span className={cn('truncate font-medium', !i.handled_at && 'text-ink')}>{i.lead?.company_name ?? i.from_email}</span>
                        <span className="shrink-0 text-xs text-muted">{formatDate(i.received_at)}</span>
                      </span>
                      <span className="mt-0.5 block truncate text-muted">{i.subject ?? '—'}</span>
                      <span className="mt-1 flex flex-wrap gap-1">
                        {cls && <Badge tone={CLASS_TONE[cls]}>{t(`inbox.classes.${cls}`)}</Badge>}
                        {i.handled_at && <Badge tone="neutral">{t('inbox.handled')}</Badge>}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
            {selected ? (
              <Panel>
                <button type="button" onClick={() => setParams({})} className="mb-3 inline-flex items-center gap-1 text-sm text-muted hover:text-ink lg:hidden">
                  <ArrowLeft className="size-4" aria-hidden />
                  {t('inbox.title')}
                </button>
                <Detail item={selected} onChanged={() => void load()} canSend={connected.some((a) => a.id === selected.account_id)} />
              </Panel>
            ) : (
              <div className="hidden rounded-[var(--radius-panel)] border border-dashed border-line lg:block" />
            )}
          </div>
        )}
      </div>
    </>
  )
}
