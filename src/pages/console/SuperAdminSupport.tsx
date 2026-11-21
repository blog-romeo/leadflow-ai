import { useState } from 'react'
import { useI18n } from '../../i18n'
import { PageHeader } from '../../components/ui/PageHeader'
import { Panel } from '../../components/ui/Panel'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { ErrorState, InlineAlert, LoadingState } from '../../components/ui/States'
import { consoleError, inputCls, post, Table, useApi } from '../../features/console/shared'
import { TicketDetail } from '../app/Support'
import { cn } from '../../lib/cn'

interface TicketItem { id: string; number: number; subject: string; category: string; priority: string; status: string; staff_unread: boolean; last_activity_at: string; organization: string; plan_code: string | null }
interface DemoItem {
  id: string; name: string; company: string; email: string; phone: string | null; sector: string; employees: string | null; message: string
  contact_preference: string; status: string; notified_at: string | null; notification_error: string | null; internal_note: string | null; created_at: string
}
const DEMO_STATUSES = ['new', 'contacted', 'scheduled', 'closed', 'spam'] as const

export default function SuperAdminSupport() {
  const { t } = useI18n()
  const [view, setView] = useState<'tickets' | 'demos'>('tickets')
  return (
    <>
      <PageHeader title={t('inbox2.title')} />
      <div role="tablist" className="mb-6 flex gap-1 border-b border-line">
        {(['tickets', 'demos'] as const).map((v) => (
          <button key={v} role="tab" type="button" aria-selected={view === v} onClick={() => setView(v)} className={cn('-mb-px border-b-2 px-3 py-2 text-sm', view === v ? 'border-flow font-medium text-flow' : 'border-transparent text-muted hover:text-ink')}>
            {t(`inbox2.${v}`)}
          </button>
        ))}
      </div>
      {view === 'tickets' ? <Tickets /> : <Demos />}
    </>
  )
}

function Tickets() {
  const { t, formatDate } = useI18n()
  const [status, setStatus] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const { data, error, loading, reload } = useApi<TicketItem[]>(`/api/super-admin/support-tickets${status ? `?status=${status}` : ''}`)
  if (open) return <TicketDetail id={open} staff onBack={() => setOpen(null)} onChanged={() => void reload()} />
  return (
    <Panel
      action={
        <select className={cn(inputCls, 'w-auto')} value={status} onChange={(e) => setStatus(e.target.value)} aria-label={t('support.priority')}>
          <option value="">{t('inbox2.filterAll')}</option>
          {['open', 'waiting_customer', 'waiting_staff', 'resolved', 'closed'].map((s) => (
            <option key={s} value={s}>{t(`support.statuses.${s}`)}</option>
          ))}
        </select>
      }
      title={t('inbox2.tickets')}
    >
      {error ? (
        <ErrorState message={t('support.errors.generic')} onRetry={() => void reload()} />
      ) : loading || !data ? (
        <LoadingState />
      ) : data.length === 0 ? (
        <p className="text-sm text-muted">{t('support.noTickets')}</p>
      ) : (
        <Table head={['#', t('support.subject'), t('inbox2.organization'), t('inbox2.plan'), t('support.priority'), t('inbox2.status'), t('support.lastActivity')]} minWidth={760}>
          {data.map((r) => (
            <tr key={r.id} className="border-t border-line">
              <td className="py-2 tabular">{r.number}</td>
              <td>
                <button type="button" onClick={() => setOpen(r.id)} className={cn('text-left text-flow hover:underline', r.staff_unread && 'font-semibold')}>
                  {r.subject}
                </button>
                {r.staff_unread && <Badge tone="flow" className="ml-2">{t('inbox2.unread')}</Badge>}
              </td>
              <td>{r.organization}</td>
              <td>{r.plan_code ?? '—'}</td>
              <td>{t(`support.priorities.${r.priority}`)}</td>
              <td>{t(`support.statuses.${r.status}`)}</td>
              <td className="text-xs text-muted">{formatDate(r.last_activity_at)}</td>
            </tr>
          ))}
        </Table>
      )}
    </Panel>
  )
}

function Demos() {
  const { t, formatDate } = useI18n()
  const [status, setStatus] = useState('new')
  const { data, error, loading, reload } = useApi<DemoItem[]>(`/api/super-admin/demo-requests${status ? `?status=${status}` : ''}`)
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {['', ...DEMO_STATUSES].map((s) => (
          <Button key={s || 'all'} size="sm" variant={status === s ? 'primary' : 'secondary'} onClick={() => setStatus(s)}>
            {s ? t(`inbox2.demoStatus.${s}`) : t('inbox2.filterAll')}
          </Button>
        ))}
      </div>
      <p className="text-xs text-muted">{t('inbox2.scheduledNote')}</p>
      {error ? (
        <ErrorState message={t('support.errors.generic')} onRetry={() => void reload()} />
      ) : loading || !data ? (
        <LoadingState />
      ) : data.length === 0 ? (
        <p className="text-sm text-muted">{t('inbox2.noDemos')}</p>
      ) : (
        data.map((d) => <DemoCard key={d.id} d={d} onSaved={() => void reload()} formatDate={formatDate} />)
      )}
    </div>
  )
}

function DemoCard({ d, onSaved, formatDate }: { d: DemoItem; onSaved: () => void; formatDate: (s: string) => string }) {
  const { t } = useI18n()
  const [st, setSt] = useState(d.status)
  const [note, setNote] = useState(d.internal_note ?? '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  return (
    <Panel title={`${d.company} — ${d.name}`} action={<Badge tone={d.status === 'new' ? 'flow' : 'neutral'}>{t(`inbox2.demoStatus.${d.status}`)}</Badge>}>
      <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <div><dt className="inline text-muted">Email: </dt><dd className="inline"><a className="text-flow hover:underline" href={`mailto:${d.email}`}>{d.email}</a></dd></div>
        {d.phone && <div><dt className="inline text-muted">Tel: </dt><dd className="inline">{d.phone}</dd></div>}
        <div><dt className="inline text-muted">{t('demo.sector')}: </dt><dd className="inline">{d.sector}</dd></div>
        <div><dt className="inline text-muted">{t('inbox2.employees')}: </dt><dd className="inline">{d.employees ?? '—'}</dd></div>
        <div><dt className="inline text-muted">{t('inbox2.contactPref')}: </dt><dd className="inline">{t(`demo.prefs.${d.contact_preference}`)}</dd></div>
        <div>
          <dt className="inline text-muted">{t('inbox2.notification')}: </dt>
          <dd className="inline">{d.notified_at ? t('inbox2.notifiedAt') : t('inbox2.notNotified', { reason: d.notification_error ?? '—' })}</dd>
        </div>
      </dl>
      <p className="mt-3 rounded-md bg-surface-2 px-3 py-2 text-sm whitespace-pre-line">{d.message}</p>
      <p className="mt-1 text-xs text-muted">{formatDate(d.created_at)}</p>
      {err && <div className="mt-3"><InlineAlert>{err}</InlineAlert></div>}
      <div className="mt-4 grid gap-2 sm:grid-cols-[12rem_1fr_auto] sm:items-end">
        <label className="text-sm">
          {t('inbox2.setStatus')}
          <select className={inputCls} value={st} onChange={(e) => setSt(e.target.value)}>
            {DEMO_STATUSES.map((s) => (
              <option key={s} value={s}>{t(`inbox2.demoStatus.${s}`)}</option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          {t('inbox2.note')}
          <input className={inputCls} value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} />
        </label>
        <Button
          size="sm"
          loading={busy}
          onClick={async () => {
            setBusy(true)
            setErr(null)
            try {
              await post('/api/super-admin/demo-request', { id: d.id, status: st, note: note || null })
              onSaved()
            } catch (e) {
              setErr(consoleError(e, t))
            } finally {
              setBusy(false)
            }
          }}
        >
          {t('inbox2.update')}
        </Button>
      </div>
    </Panel>
  )
}
