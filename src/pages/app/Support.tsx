import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Bell, ChevronDown, LifeBuoy, Search } from 'lucide-react'
import { useI18n } from '../../i18n'
import { useAuth } from '../../contexts/AuthContext'
import { supabase } from '../../lib/supabase'
import { useNoIndex } from '../../lib/seo'
import { HELP_ARTICLES, HELP_CATEGORIES, searchHelp, type HelpCategory } from '../../content/help'
import type { NotificationRow, SupportTicketMessageRow, SupportTicketRow, TicketCategory, TicketPriority, TicketStatus } from '../../lib/database.types'
import { PageHeader } from '../../components/ui/PageHeader'
import { Panel } from '../../components/ui/Panel'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { Field, Select } from '../../components/ui/Field'
import { EmptyState, ErrorState, InlineAlert, LoadingState } from '../../components/ui/States'
import { AssistantChat } from '../../features/support/Assistant'
import { cn } from '../../lib/cn'

type Tab = 'help' | 'tickets' | 'notifications'
const CATEGORIES: TicketCategory[] = ['account', 'billing', 'lead_finder', 'ai', 'crm', 'campaigns', 'white_label', 'privacy', 'bug', 'other']
const PRIORITIES: TicketPriority[] = ['low', 'normal', 'high', 'urgent']
const STATUS_TONE: Record<TicketStatus, 'flow' | 'signal' | 'ok' | 'neutral'> = { open: 'flow', waiting_customer: 'signal', waiting_staff: 'flow', resolved: 'ok', closed: 'neutral' }
const textareaCls =
  'w-full rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-muted/80 focus:border-flow focus:outline-none focus:ring-2 focus:ring-flow/25'

function supportError(err: { message?: string } | null, t: (k: string) => string) {
  const code = err?.message ?? ''
  return t(`support.errors.${['rate_limited', 'ticket_closed'].includes(code) ? code : 'generic'}`)
}

export default function Support() {
  const { t } = useI18n()
  useNoIndex(t('support.title'))
  const [params, setParams] = useSearchParams()
  const tab = (['help', 'tickets', 'notifications'].includes(params.get('tab') ?? '') ? params.get('tab') : params.get('ticket') ? 'tickets' : 'help') as Tab
  const setTab = (t: Tab) => setParams({ tab: t }, { replace: true })
  const tabs: { id: Tab; icon: typeof Bell }[] = [
    { id: 'help', icon: LifeBuoy },
    { id: 'tickets', icon: ChevronDown },
    { id: 'notifications', icon: Bell },
  ]
  return (
    <>
      <PageHeader title={t('support.title')} subtitle={t('support.subtitle')} />
      <div role="tablist" aria-label={t('support.title')} className="mb-6 flex gap-1 border-b border-line">
        {tabs.map(({ id }) => (
          <button
            key={id}
            role="tab"
            type="button"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={cn('-mb-px border-b-2 px-3 py-2 text-sm', tab === id ? 'border-flow font-medium text-flow' : 'border-transparent text-muted hover:text-ink')}
          >
            {t(`support.tabs.${id}`)}
          </button>
        ))}
      </div>
      {tab === 'help' && <HelpTab initialArticle={params.get('article')} />}
      {tab === 'tickets' && <TicketsTab openId={params.get('ticket')} startNew={params.get('new') === '1'} />}
      {tab === 'notifications' && <NotificationsTab />}
    </>
  )
}

function HelpTab({ initialArticle }: { initialArticle: string | null }) {
  const { t, locale } = useI18n()
  const [q, setQ] = useState('')
  const [category, setCategory] = useState<HelpCategory | 'all'>('all')
  const results = useMemo(() => {
    if (q.trim().length >= 2) return searchHelp(q, locale, 10).map((h) => h.article)
    return HELP_ARTICLES.filter((a) => category === 'all' || a.category === category)
  }, [q, category, locale])
  return (
    <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
      <div>
        <div className="flex flex-col gap-3 sm:flex-row">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute top-3 left-3 size-4 text-muted" aria-hidden />
            <label htmlFor="help-q" className="sr-only">{t('support.search')}</label>
            <input
              id="help-q"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t('support.search')}
              className="h-10 w-full rounded-[var(--radius-control)] border border-line bg-surface pr-3 pl-9 text-sm focus:border-flow focus:outline-none focus:ring-2 focus:ring-flow/25"
            />
          </div>
          <Select label={t('support.category')} hideLabel value={category} onChange={(e) => setCategory(e.target.value as HelpCategory | 'all')} className="sm:w-56">
            <option value="all">{t('inbox2.filterAll')}</option>
            {(Object.keys(HELP_CATEGORIES) as HelpCategory[]).map((c) => (
              <option key={c} value={c}>{HELP_CATEGORIES[c][locale]}</option>
            ))}
          </Select>
        </div>
        {results.length === 0 ? (
          <p className="mt-6 text-sm text-muted">{t('support.noResults')}</p>
        ) : (
          <div className="mt-4 divide-y divide-line rounded-[var(--radius-panel)] border border-line bg-surface">
            {results.map((a) => (
              <details key={a.id} open={a.id === initialArticle} className="group px-5 py-4">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
                  <span>
                    <span className="block text-xs text-muted">{HELP_CATEGORIES[a.category][locale]}</span>
                    <span className="font-medium">{a.title[locale]}</span>
                  </span>
                  <ChevronDown className="size-4 shrink-0 text-muted transition-transform group-open:rotate-180" aria-hidden />
                </summary>
                <p className="mt-3 text-sm text-muted">{a.body[locale]}</p>
                {a.link && (
                  <Link to={a.link} className="mt-2 inline-block text-sm font-medium text-flow hover:underline">
                    {t('support.openApp')} →
                  </Link>
                )}
              </details>
            ))}
          </div>
        )}
      </div>
      <div className="space-y-4">
        <Panel title={t('assistant.title')}>
          <AssistantChat />
        </Panel>
        <p className="text-xs text-muted">{t('support.aiChatSoon')}</p>
      </div>
    </div>
  )
}

function TicketsTab({ openId, startNew }: { openId: string | null; startNew: boolean }) {
  const { t, formatDate } = useI18n()
  const { currentOrg } = useAuth()
  const [, setParams] = useSearchParams()
  const [rows, setRows] = useState<SupportTicketRow[] | null>(null)
  const [error, setError] = useState(false)
  const [creating, setCreating] = useState(startNew)

  const load = useCallback(async () => {
    if (!supabase || !currentOrg) return
    setError(false)
    const { data, error: err } = await supabase
      .from('support_tickets')
      .select('*')
      .eq('organization_id', currentOrg.id)
      .order('last_activity_at', { ascending: false })
      .limit(100)
    if (err) return setError(true)
    setRows((data ?? []) as SupportTicketRow[])
  }, [currentOrg])
  useEffect(() => {
    void load()
  }, [load])

  if (openId) return <TicketDetail id={openId} onBack={() => setParams({ tab: 'tickets' }, { replace: true })} onChanged={() => void load()} />
  return (
    <div className="space-y-6">
      {creating ? (
        <NewTicket
          onCancel={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false)
            void load()
            setParams({ tab: 'tickets', ticket: id }, { replace: true })
          }}
        />
      ) : (
        <Button onClick={() => setCreating(true)}>{t('support.newTicket')}</Button>
      )}
      <Panel>
        {error ? (
          <ErrorState message={t('support.errors.generic')} onRetry={() => void load()} />
        ) : !rows ? (
          <LoadingState />
        ) : rows.length === 0 ? (
          <EmptyState icon={LifeBuoy} title={t('support.noTickets')} className="py-6" />
        ) : (
          <ul className="divide-y divide-line">
            {rows.map((r) => (
              <li key={r.id}>
                <Link to={`/app/support?ticket=${r.id}`} className="flex flex-col gap-1 py-3 hover:bg-surface-2 sm:flex-row sm:items-center sm:gap-4 sm:px-2">
                  <span className="text-xs text-muted tabular">#{r.number}</span>
                  <span className={cn('flex-1 truncate', r.customer_unread && 'font-semibold')}>{r.subject}</span>
                  <Badge tone={STATUS_TONE[r.status]}>{t(`support.statuses.${r.status}`)}</Badge>
                  <time className="text-xs text-muted" dateTime={r.last_activity_at}>{formatDate(r.last_activity_at)}</time>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  )
}

function NewTicket({ onCancel, onCreated }: { onCancel: () => void; onCreated: (id: string) => void }) {
  const { t } = useI18n()
  const { currentOrg } = useAuth()
  const [v, setV] = useState({ subject: '', category: 'other' as TicketCategory, priority: 'normal' as TicketPriority, body: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!supabase || !currentOrg || v.subject.trim().length < 3 || v.body.trim().length < 1) return
    setBusy(true)
    setError(null)
    const { data, error: err } = await supabase.rpc('support_create_ticket', { p_org: currentOrg.id, p_subject: v.subject.trim(), p_category: v.category, p_priority: v.priority, p_body: v.body.trim() })
    setBusy(false)
    if (err || !data) return setError(supportError(err, t))
    onCreated(data)
  }
  return (
    <Panel title={t('support.newTicket')}>
      <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
        {error && <div className="sm:col-span-2"><InlineAlert>{error}</InlineAlert></div>}
        <Field label={t('support.subject')} value={v.subject} onChange={(e) => setV({ ...v, subject: e.target.value })} minLength={3} maxLength={160} required className="sm:col-span-2" />
        <Select label={t('support.category')} value={v.category} onChange={(e) => setV({ ...v, category: e.target.value as TicketCategory })}>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>{t(`support.categories.${c}`)}</option>
          ))}
        </Select>
        <Select label={t('support.priority')} value={v.priority} onChange={(e) => setV({ ...v, priority: e.target.value as TicketPriority })}>
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>{t(`support.priorities.${p}`)}</option>
          ))}
        </Select>
        <div className="space-y-1.5 sm:col-span-2">
          <label htmlFor="ticket-body" className="block text-sm font-medium">{t('support.description')}</label>
          <textarea id="ticket-body" rows={5} value={v.body} onChange={(e) => setV({ ...v, body: e.target.value })} maxLength={5000} required aria-describedby="ticket-body-hint" className={textareaCls} />
          <p id="ticket-body-hint" className="text-xs text-muted">{t('support.descriptionHint')}</p>
        </div>
        <div className="flex gap-2 sm:col-span-2">
          <Button type="submit" loading={busy}>{t('support.create')}</Button>
          <Button variant="ghost" onClick={onCancel}>{t('common.cancel')}</Button>
        </div>
      </form>
    </Panel>
  )
}

/** Dettaglio ticket con cronologia. Usato dal cliente e (con staff=true) dalla console. */
export function TicketDetail({ id, onBack, onChanged, staff }: { id: string; onBack: () => void; onChanged?: () => void; staff?: boolean }) {
  const { t, formatDate } = useI18n()
  const [ticket, setTicket] = useState<SupportTicketRow | null>(null)
  const [messages, setMessages] = useState<SupportTicketMessageRow[] | null>(null)
  const [reply, setReply] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(async () => {
    if (!supabase) return
    const [tk, ms] = await Promise.all([
      supabase.from('support_tickets').select('*').eq('id', id).maybeSingle(),
      supabase.from('support_ticket_messages').select('*').eq('ticket_id', id).order('created_at'),
    ])
    if (tk.error || ms.error || !tk.data) return setError(t('support.errors.generic'))
    setTicket(tk.data as SupportTicketRow)
    setMessages((ms.data ?? []) as SupportTicketMessageRow[])
    await supabase.rpc('support_mark_read', { p_ticket: id })
  }, [id, t])
  useEffect(() => {
    void load()
  }, [load])

  async function act(fn: () => PromiseLike<{ error: { message?: string } | null }>) {
    setBusy(true)
    setError(null)
    const { error: err } = await fn()
    setBusy(false)
    if (err) return setError(supportError(err, t))
    setReply('')
    await load()
    onChanged?.()
  }

  if (!ticket || !messages) return error ? <ErrorState message={error} onRetry={() => void load()} /> : <LoadingState />
  const closed = ticket.status === 'closed'
  return (
    <div className="space-y-4">
      <button type="button" onClick={onBack} className="text-sm text-flow hover:underline">← {t('support.tabs.tickets')}</button>
      <Panel
        title={`${t('support.number', { n: ticket.number })} · ${ticket.subject}`}
        action={<Badge tone={STATUS_TONE[ticket.status]}>{t(`support.statuses.${ticket.status}`)}</Badge>}
      >
        <p className="mb-4 text-xs text-muted">
          {t(`support.categories.${ticket.category}`)} · {t(`support.priorities.${ticket.priority}`)}
        </p>
        {error && <div className="mb-3"><InlineAlert>{error}</InlineAlert></div>}
        <ol className="space-y-3">
          {messages.map((m) => (
            <li key={m.id} className={cn('rounded-lg border px-4 py-3 text-sm', m.author_role === 'staff' ? 'border-flow/40 bg-flow-soft' : 'border-line bg-surface')}>
              <p className="mb-1 text-xs text-muted">
                <strong className="text-ink">{m.author_role === 'staff' ? t('support.staff') : staff ? t('inbox2.organization') : t('support.you')}</strong> ·{' '}
                <time dateTime={m.created_at}>{formatDate(m.created_at)}</time>
              </p>
              <p className="whitespace-pre-line">{m.body}</p>
            </li>
          ))}
        </ol>
        {!closed || staff ? (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              if (reply.trim()) void act(() => supabase!.rpc('support_reply', { p_ticket: id, p_body: reply.trim() }))
            }}
            className="mt-4 space-y-2"
          >
            <label htmlFor="ticket-reply" className="sr-only">{t('support.reply')}</label>
            <textarea id="ticket-reply" rows={3} value={reply} onChange={(e) => setReply(e.target.value)} maxLength={5000} placeholder={t('support.replyPlaceholder')} className={textareaCls} />
            <div className="flex flex-wrap gap-2">
              <Button type="submit" loading={busy} disabled={!reply.trim()}>{staff ? t('inbox2.replyAsStaff') : t('support.reply')}</Button>
              {!staff && !closed && (
                <Button variant="ghost" onClick={() => void act(() => supabase!.rpc('support_set_status', { p_ticket: id, p_status: 'closed' }))}>{t('support.closeTicket')}</Button>
              )}
            </div>
          </form>
        ) : (
          <Button variant="secondary" className="mt-4" onClick={() => void act(() => supabase!.rpc('support_set_status', { p_ticket: id, p_status: 'open' }))}>
            {t('support.reopen')}
          </Button>
        )}
        {staff && (
          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-4">
            <span className="text-sm text-muted">{t('inbox2.setStatus')}:</span>
            {(['open', 'waiting_customer', 'waiting_staff', 'resolved', 'closed'] as TicketStatus[]).map((s) => (
              <Button key={s} size="sm" variant={ticket.status === s ? 'primary' : 'secondary'} disabled={busy || ticket.status === s} onClick={() => void act(() => supabase!.rpc('support_set_status', { p_ticket: id, p_status: s }))}>
                {t(`support.statuses.${s}`)}
              </Button>
            ))}
          </div>
        )}
      </Panel>
    </div>
  )
}

function NotificationsTab() {
  const { t, formatDate } = useI18n()
  const { currentOrg, user } = useAuth()
  const [rows, setRows] = useState<NotificationRow[] | null>(null)
  const load = useCallback(async () => {
    if (!supabase || !currentOrg) return
    const { data } = await supabase.from('notifications').select('*').eq('organization_id', currentOrg.id).order('created_at', { ascending: false }).limit(50)
    setRows((data ?? []) as NotificationRow[])
  }, [currentOrg])
  useEffect(() => {
    void load()
  }, [load])
  if (!rows) return <LoadingState />
  if (rows.length === 0) return <EmptyState icon={Bell} title={t('support.notificationsEmpty')} />
  return (
    <Panel>
      <ul className="divide-y divide-line">
        {rows.map((n) => (
          <li key={n.id} className="flex flex-col gap-1 py-3 sm:flex-row sm:items-center sm:gap-4">
            <span className={cn('flex-1', !n.read_at && 'font-semibold')}>
              {n.link ? <Link to={n.link} className="hover:underline">{n.title}</Link> : n.title}
              {n.body && <span className="block text-sm font-normal text-muted">{n.body}</span>}
            </span>
            <time className="text-xs text-muted" dateTime={n.created_at}>{formatDate(n.created_at)}</time>
            {!n.read_at && n.user_id === user?.id && (
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  await supabase!.from('notifications').update({ read_at: new Date().toISOString() }).eq('id', n.id)
                  void load()
                }}
              >
                {t('support.markRead')}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </Panel>
  )
}
