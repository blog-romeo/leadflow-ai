import { useState } from 'react'
import { useI18n } from '../../i18n'
import { useDebounced } from '../../lib/useDebounced'
import { PageHeader } from '../../components/ui/PageHeader'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { Dialog } from '../../components/ui/Dialog'
import { ErrorState, InlineAlert, LoadingState } from '../../components/ui/States'
import { ReasonDialog, Table, consoleError, inputCls, post, useApi, useFormatters } from '../../features/console/shared'

interface OrgRow {
  id: string
  name: string
  slug: string
  country: string
  created_at: string
  admin_status: 'active' | 'suspended'
  suspended_reason: string | null
  plan_code: string | null
  subscription_status: string | null
  source: string | null
  has_access: boolean
  users: number
  credits_used: number
  leads_acquired: number
  reseller: string | null
}

interface Detail {
  organization: { id: string; name: string; slug: string; country: string; vat_number: string | null; created_at: string; admin_status: string; suspended_reason: string | null; ai_monthly_cap_usd: number | null }
  entitlements: { plan_code: string | null; status: string | null; source: string | null; has_access: boolean }
  users: number
  ai_cost_month_usd: number
  usage_periods: { period_start: string; period_end: string; plan_code: string | null; ai_credits_used: number; ai_credits_limit: number; leads_used: number; leads_limit: number }[]
  events: { at: string; source: string; action: string; reason?: string | null }[]
  notes: { id: string; body: string; created_at: string; author: string | null }[]
  reseller: { id: string; name: string; client_plan_code: string } | null
}

function OrgDetail({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { t, formatDate } = useI18n()
  const { num } = useFormatters()
  const { data: d, error, loading, reload } = useApi<Detail>(`/api/super-admin/organization?id=${id}`)
  const [action, setAction] = useState<'suspend' | 'reactivate' | 'cap' | null>(null)
  const [note, setNote] = useState('')
  const [cap, setCap] = useState('')
  const [msg, setMsg] = useState<string | null>(null)

  const refresh = async () => {
    await reload()
    onChanged()
  }

  return (
    <Dialog open onClose={onClose} variant="drawer" title={d?.organization.name ?? t('saOrgs.detailTitle')} closeLabel={t('console.close')}>
      {loading && !d ? <LoadingState /> : error || !d ? <ErrorState message={t('console.loadError')} onRetry={() => void reload()} /> : (
        <div className="space-y-5 text-sm">
          {msg && <InlineAlert>{msg}</InlineAlert>}
          <dl className="grid grid-cols-2 gap-2">
            <dt className="text-muted">{t('saOrgs.colPlan')}</dt>
            <dd className="capitalize">{d.entitlements.plan_code ?? t('saOrgs.noPlan')} · {d.entitlements.status ?? '—'}</dd>
            <dt className="text-muted">{t('saOrgs.colCreated')}</dt>
            <dd>{formatDate(d.organization.created_at)}</dd>
            <dt className="text-muted">{t('saOrgs.colUsers')}</dt>
            <dd>{num(d.users)}</dd>
            <dt className="text-muted">VAT</dt>
            <dd>{d.organization.vat_number ?? '—'}</dd>
          </dl>
          {d.reseller && <p className="text-muted">{t('saOrgs.managedBy', { name: d.reseller.name, plan: d.reseller.client_plan_code })}</p>}
          {d.organization.admin_status === 'suspended' && <InlineAlert>{t('saOrgs.suspendedReason', { reason: d.organization.suspended_reason ?? '—' })}</InlineAlert>}
          <div className="flex flex-wrap gap-2">
            {d.organization.admin_status === 'suspended' ? (
              <Button size="sm" onClick={() => setAction('reactivate')}>{t('saOrgs.reactivate')}</Button>
            ) : (
              <Button size="sm" variant="danger" onClick={() => setAction('suspend')}>{t('saOrgs.suspend')}</Button>
            )}
          </div>

          <section>
            <h3 className="font-semibold">{t('saOrgs.aiCap')}</h3>
            <p className="text-xs text-muted">{t('saOrgs.aiCapHint', { spent: d.ai_cost_month_usd.toFixed(2) })}</p>
            <div className="mt-2 flex gap-2">
              <input className={inputCls} type="number" min={0} step="0.01" placeholder={d.organization.ai_monthly_cap_usd?.toString() ?? '—'} value={cap} onChange={(e) => setCap(e.target.value)} aria-label={t('saOrgs.aiCap')} />
              <Button size="sm" variant="secondary" onClick={() => setAction('cap')}>{t('console.save')}</Button>
            </div>
          </section>

          <section>
            <h3 className="font-semibold">{t('saOrgs.periods')}</h3>
            <ul className="mt-1 divide-y divide-line">
              {d.usage_periods.map((p) => (
                <li key={p.period_start} className="flex flex-wrap justify-between gap-2 py-1.5">
                  <span>{formatDate(p.period_start)} – {formatDate(p.period_end)} <span className="capitalize text-muted">{p.plan_code ?? ''}</span></span>
                  <span className="tabular text-muted">{t('saOrgs.credits', { used: p.ai_credits_used, limit: p.ai_credits_limit })} · {t('saOrgs.leads', { used: p.leads_used, limit: p.leads_limit })}</span>
                </li>
              ))}
              {d.usage_periods.length === 0 && <li className="py-1.5 text-muted">{t('console.none')}</li>}
            </ul>
          </section>

          <section>
            <h3 className="font-semibold">{t('saOrgs.notes')}</h3>
            <form className="mt-2 flex gap-2" onSubmit={async (e) => {
              e.preventDefault()
              if (!note.trim()) return
              try {
                await post('/api/super-admin/note-add', { target_type: 'organization', target_id: id, body: note.trim() })
                setNote('')
                await reload()
              } catch (err) {
                setMsg(consoleError(err, t))
              }
            }}>
              <input className={inputCls} value={note} maxLength={4000} placeholder={t('saOrgs.notePlaceholder')} onChange={(e) => setNote(e.target.value)} aria-label={t('saOrgs.addNote')} />
              <Button size="sm" type="submit" variant="secondary">{t('saOrgs.addNote')}</Button>
            </form>
            <ul className="mt-2 space-y-2">
              {d.notes.map((n) => (
                <li key={n.id} className="rounded-md border border-line p-2">
                  <p className="whitespace-pre-wrap">{n.body}</p>
                  <p className="mt-1 text-xs text-muted">{n.author ?? '—'} · {formatDate(n.created_at)}</p>
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h3 className="font-semibold">{t('saOrgs.events')}</h3>
            <ul className="mt-1 divide-y divide-line">
              {d.events.map((e, i) => (
                <li key={i} className="py-1.5">
                  <span className="font-mono text-xs">{e.action}</span> <span className="text-xs text-muted">· {e.source} · {formatDate(e.at)}</span>
                  {e.reason && <p className="text-xs text-muted">{e.reason}</p>}
                </li>
              ))}
              {d.events.length === 0 && <li className="py-1.5 text-muted">{t('console.none')}</li>}
            </ul>
          </section>

          <ReasonDialog
            open={action === 'suspend' || action === 'reactivate'}
            danger={action === 'suspend'}
            title={t(action === 'suspend' ? 'saOrgs.suspendTitle' : 'saOrgs.reactivateTitle', { name: d.organization.name })}
            body={t(action === 'suspend' ? 'saOrgs.suspendBody' : 'saOrgs.reactivateBody')}
            onClose={() => setAction(null)}
            onConfirm={async (reason) => {
              await post('/api/super-admin/organization-status', { organization_id: id, action, reason })
              await refresh()
            }}
          />
          <ReasonDialog
            open={action === 'cap'}
            title={t('saOrgs.aiCap')}
            onClose={() => setAction(null)}
            onConfirm={async (reason) => {
              const value = cap.trim() === '' ? null : Number(cap)
              await post('/api/super-admin/org-ai-cap', { organization_id: id, cap_usd: value, reason })
              setCap('')
              await refresh()
            }}
          />
        </div>
      )}
    </Dialog>
  )
}

export default function SuperAdminOrganizations() {
  const { t, formatDate } = useI18n()
  const { num } = useFormatters()
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('')
  const [page, setPage] = useState(1)
  const [open, setOpen] = useState<string | null>(null)
  const dq = useDebounced(q.trim(), 300)
  const { data, error, loading, reload } = useApi<{ total: number; rows: OrgRow[] }>(
    `/api/super-admin/organizations?page=${page}${dq ? `&q=${encodeURIComponent(dq)}` : ''}${status ? `&status=${status}` : ''}`,
  )
  const pages = Math.max(1, Math.ceil((data?.total ?? 0) / 25))

  return (
    <>
      <PageHeader title={t('saOrgs.title')} />
      <div className="mb-4 flex flex-wrap gap-2">
        <input className={`${inputCls} max-w-sm`} value={q} onChange={(e) => { setQ(e.target.value); setPage(1) }} placeholder={t('saOrgs.search')} aria-label={t('saOrgs.search')} />
        <select className={`${inputCls} w-auto`} value={status} onChange={(e) => { setStatus(e.target.value); setPage(1) }} aria-label={t('saOrgs.status')}>
          <option value="">{t('saOrgs.all')}</option>
          <option value="active">{t('saOrgs.active')}</option>
          <option value="suspended">{t('saOrgs.suspended')}</option>
        </select>
      </div>
      {loading && !data ? <LoadingState /> : error || !data ? <ErrorState message={t('console.loadError')} onRetry={() => void reload()} /> : (
        <>
          <Table minWidth={900} head={[t('saOrgs.colName'), t('saOrgs.colPlan'), t('saOrgs.colSub'), t('saOrgs.colCreated'), t('saOrgs.colUsers'), t('saOrgs.colCredits'), t('saOrgs.colLeads'), t('saOrgs.colStatus'), '']}>
            {data.rows.map((r) => (
              <tr key={r.id}>
                <td className="py-2 pr-3">
                  <span className="font-medium">{r.name}</span>
                  {r.reseller && <span className="block text-xs text-muted">{t('saOrgs.reseller', { name: r.reseller })}</span>}
                </td>
                <td className="py-2 pr-3 capitalize">{r.plan_code ?? t('saOrgs.noPlan')}</td>
                <td className="py-2 pr-3"><Badge tone={r.has_access ? 'ok' : 'neutral'}>{r.subscription_status ?? '—'}</Badge></td>
                <td className="py-2 pr-3">{formatDate(r.created_at)}</td>
                <td className="tabular py-2 pr-3">{num(r.users)}</td>
                <td className="tabular py-2 pr-3">{num(r.credits_used)}</td>
                <td className="tabular py-2 pr-3">{num(r.leads_acquired)}</td>
                <td className="py-2 pr-3"><Badge tone={r.admin_status === 'suspended' ? 'danger' : 'ok'}>{t(`saOrgs.${r.admin_status}`)}</Badge></td>
                <td className="py-2"><Button size="sm" variant="ghost" onClick={() => setOpen(r.id)}>{t('saOrgs.details')}</Button></td>
              </tr>
            ))}
          </Table>
          {data.rows.length === 0 && <p className="py-6 text-center text-sm text-muted">{t('console.none')}</p>}
          <div className="mt-3 flex items-center justify-end gap-2 text-sm">
            <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>‹</Button>
            <span className="tabular">{page}/{pages}</span>
            <Button size="sm" variant="ghost" disabled={page >= pages} onClick={() => setPage(page + 1)}>›</Button>
          </div>
        </>
      )}
      {open && <OrgDetail id={open} onClose={() => setOpen(null)} onChanged={() => void reload()} />}
    </>
  )
}
