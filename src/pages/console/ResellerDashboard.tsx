import { useEffect, useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useI18n } from '../../i18n'
import { PageHeader } from '../../components/ui/PageHeader'
import { Panel } from '../../components/ui/Panel'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { EmptyState, ErrorState, InlineAlert, LoadingState } from '../../components/ui/States'
import { Store } from 'lucide-react'
import { Kpi } from '../../features/campaigns/shared'
import { Table, consoleError, inputCls, post, useApi, useFormatters } from '../../features/console/shared'

export interface ResellerRef { id: string; name: string; role: 'reseller_admin' | 'reseller_member'; status: string }
interface Dashboard {
  reseller: { id: string; name: string; status: 'active' | 'suspended'; suspended_reason: string | null; plan_code: string }
  role: 'reseller_admin' | 'reseller_member'
  access: { has_access: boolean; reason: string; max_organizations: number; max_custom_domains: number; allowed_client_plans: string[]; subscription_status: string | null; subscription_source: string | null }
  plan: { name: string; setup_fee_cents: number; monthly_price_cents: number; max_organizations: number; max_custom_domains: number; currency: string } | null
  subscription: { source: string; status: string; current_period_end: string | null; cancel_at_period_end: boolean; livemode: boolean } | null
  has_billing_account: boolean
  clients: { organization_id: string; name: string; client_plan_code: string; admin_status: string; users: number; credits_used: number; credits_limit: number; credits_available: number; leads_used: number; leads_limit: number; wholesale_cents: number }[]
  invitations: { id: string; email: string; organization_name: string; client_plan_code: string; status: string; expires_at: string }[]
  branding: { platform_name: string | null } | null
  domains: { id: string; hostname: string; status: string; dns_status: string; https_status: string; provisioning: string; verification_token: string | null; last_error: string | null }[]
  cname_target: string | null
}

/** Rivenditore selezionato (se l'utente appartiene a più rivenditori). */
export function useReseller() {
  const { data, error, loading } = useApi<{ resellers: ResellerRef[] }>('/api/reseller/me')
  const [selected, setSelected] = useState<string | null>(null)
  const list = data?.resellers ?? []
  const current = list.find((r) => r.id === selected) ?? list[0] ?? null
  return { list, current, setSelected, error, loading }
}

function safeStripe(url: string): string | null {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && (u.hostname === 'stripe.com' || u.hostname.endsWith('.stripe.com')) ? u.href : null
  } catch {
    return null
  }
}

function Invitations({ d, onChanged }: { d: Dashboard; onChanged: () => void }) {
  const { t, formatDate } = useI18n()
  const [f, setF] = useState({ email: '', organization_name: '', client_plan_code: d.access.allowed_client_plans[0] ?? 'starter' })
  const [link, setLink] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setLink(null)
    try {
      const r = await post<{ invite_url: string }>('/api/reseller/invitation-create', { reseller_id: d.reseller.id, ...f })
      setLink(r.invite_url)
      setF({ ...f, email: '', organization_name: '' })
      onChanged()
    } catch (err) {
      setError(consoleError(err, t))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Panel title={t('resellerPortal.invitations')}>
      <form onSubmit={submit} className="grid gap-2 text-sm md:grid-cols-4">
        <input className={inputCls} type="email" required placeholder={t('resellerPortal.inviteEmail')} value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} aria-label={t('resellerPortal.inviteEmail')} />
        <input className={inputCls} required minLength={2} maxLength={120} placeholder={t('resellerPortal.inviteOrg')} value={f.organization_name} onChange={(e) => setF({ ...f, organization_name: e.target.value })} aria-label={t('resellerPortal.inviteOrg')} />
        <select className={inputCls} value={f.client_plan_code} onChange={(e) => setF({ ...f, client_plan_code: e.target.value })} aria-label={t('resellerPortal.invitePlan')}>
          {d.access.allowed_client_plans.map((p) => <option key={p} value={p} className="capitalize">{p}</option>)}
        </select>
        <Button type="submit" loading={busy} disabled={!d.access.has_access}>{t('resellerPortal.invite')}</Button>
      </form>
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
      {link && (
        <div className="mt-3 rounded-md border border-line p-3 text-sm">
          <p className="text-xs text-muted">{t('resellerPortal.inviteLink')}</p>
          <div className="mt-1 flex gap-2">
            <input className={`${inputCls} font-mono text-xs`} readOnly value={link} onFocus={(e) => e.target.select()} aria-label={t('resellerPortal.inviteLink')} />
            <Button size="sm" variant="secondary" onClick={() => void navigator.clipboard?.writeText(link).then(() => setCopied(true))}>{copied ? t('console.copied') : t('console.copy')}</Button>
          </div>
        </div>
      )}
      <ul className="mt-3 divide-y divide-line text-sm">
        {d.invitations.map((i) => (
          <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
            <span>{i.organization_name} <span className="text-muted">· {i.email} · <span className="capitalize">{i.client_plan_code}</span> · {formatDate(i.expires_at)}</span></span>
            <span className="flex items-center gap-2">
              <Badge tone={i.status === 'accepted' ? 'ok' : i.status === 'pending' ? 'flow' : 'neutral'}>{t(`resellerPortal.invStatus.${i.status}`)}</Badge>
              {i.status === 'pending' && <Button size="sm" variant="ghost" onClick={async () => { await post('/api/reseller/invitation-revoke', { reseller_id: d.reseller.id, invitation_id: i.id }).catch(() => undefined); onChanged() }}>{t('resellerPortal.revoke')}</Button>}
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  )
}

function Domains({ d, onChanged }: { d: Dashboard; onChanged: () => void }) {
  const { t } = useI18n()
  const [host, setHost] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const admin = d.role === 'reseller_admin'
  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key)
    setError(null)
    try {
      await fn()
      onChanged()
    } catch (err) {
      setError(consoleError(err, t))
    } finally {
      setBusy(null)
    }
  }
  return (
    <Panel title={t('resellerPortal.domains')}>
      {admin && (
        <form className="flex max-w-xl gap-2 text-sm" onSubmit={(e) => { e.preventDefault(); void run('add', async () => { await post('/api/reseller/domain-add', { reseller_id: d.reseller.id, hostname: host }); setHost('') }) }}>
          <input className={inputCls} value={host} placeholder={t('resellerPortal.addDomain')} onChange={(e) => setHost(e.target.value)} aria-label={t('resellerPortal.addDomain')} />
          <Button size="sm" type="submit" loading={busy === 'add'} disabled={!host.trim()}>{t('resellerPortal.add')}</Button>
        </form>
      )}
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
      <ul className="mt-3 space-y-3 text-sm">
        {d.domains.map((dm) => (
          <li key={dm.id} className="rounded-md border border-line p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-mono">{dm.hostname}</span>
              <span className="flex flex-wrap items-center gap-2">
                <Badge tone={dm.status === 'active' ? 'ok' : dm.status === 'verified' ? 'flow' : 'signal'}>{t(`resellerPortal.domainStatus.${dm.status}`)}</Badge>
                <Badge tone={dm.dns_status === 'ok' ? 'ok' : 'neutral'}>{t(`resellerPortal.dnsStatus.${dm.dns_status}`)}</Badge>
                <Badge tone={dm.https_status === 'active' ? 'ok' : dm.https_status === 'error' ? 'danger' : 'neutral'}>{t(`resellerPortal.httpsStatus.${dm.https_status}`)}</Badge>
              </span>
            </div>
            {dm.provisioning !== 'manual_done' && <p className="mt-1 text-xs text-muted">{t('resellerPortal.provisioningPending')}</p>}
            {dm.last_error && <p className="mt-1 font-mono text-xs text-muted">{dm.last_error}</p>}
            {admin && dm.verification_token && (
              <div className="mt-2 rounded bg-surface-2 p-2 font-mono text-xs">
                <p className="mb-1 font-sans font-medium">{t('resellerPortal.dnsTitle')}</p>
                <p className="break-all">{t('resellerPortal.dnsTxt', { name: `_leadflow-challenge.${dm.hostname}`, value: `leadflow-verify=${dm.verification_token}` })}</p>
                <p className="break-all">{d.cname_target ? t('resellerPortal.dnsCname', { host: dm.hostname, target: d.cname_target }) : t('resellerPortal.dnsCnameMissing')}</p>
              </div>
            )}
            {admin && (
              <div className="mt-2 flex gap-2">
                <Button size="sm" variant="secondary" loading={busy === `v${dm.id}`} onClick={() => void run(`v${dm.id}`, () => post('/api/reseller/domain-verify', { reseller_id: d.reseller.id, domain_id: dm.id }))}>{t('resellerPortal.verify')}</Button>
                <Button size="sm" variant="ghost" loading={busy === `r${dm.id}`} onClick={() => void run(`r${dm.id}`, () => post('/api/reseller/domain-remove', { reseller_id: d.reseller.id, domain_id: dm.id }))}>{t('resellerPortal.remove')}</Button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </Panel>
  )
}

export default function ResellerDashboard() {
  const { t, formatDate } = useI18n()
  const { money, num } = useFormatters()
  const { list, current, setSelected, error: listError, loading: listLoading } = useReseller()
  const { data: d, error, loading, reload } = useApi<Dashboard>(current ? `/api/reseller/dashboard?reseller_id=${current.id}` : null)
  const [params, setParams] = useSearchParams()
  const [checkout, setCheckout] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const flag = params.get('checkout')
    if (!flag) return
    setCheckout(flag)
    const next = new URLSearchParams(params)
    next.delete('checkout')
    setParams(next, { replace: true })
  }, [params, setParams])

  if (listLoading) return <LoadingState />
  if (listError) return <ErrorState message={t('console.loadError')} />
  if (!current) return <EmptyState icon={Store} title={t('console.resellerForbidden')} className="py-20" />
  if (loading && !d) return <LoadingState />
  if (error || !d) return <ErrorState message={t('console.loadError')} onRetry={() => void reload()} />

  const admin = d.role === 'reseller_admin'
  const totals = d.clients.reduce((a, c) => ({ used: a.used + c.credits_used, avail: a.avail + c.credits_available, wholesale: a.wholesale + c.wholesale_cents }), { used: 0, avail: 0, wholesale: 0 })
  const billing = async (path: 'billing-checkout' | 'billing-portal') => {
    setBusy(true)
    setActionError(null)
    try {
      const r = await post<{ url: string }>(`/api/reseller/${path}`, { reseller_id: d.reseller.id })
      const url = safeStripe(r.url)
      if (url) window.location.assign(url)
    } catch (err) {
      setActionError(consoleError(err, t))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <PageHeader title={d.branding?.platform_name ?? d.reseller.name} subtitle={t('resellerPortal.subtitle')}
        actions={list.length > 1 ? (
          <select className={`${inputCls} w-auto`} value={current.id} onChange={(e) => setSelected(e.target.value)} aria-label={t('resellerPortal.choose')}>
            {list.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        ) : undefined}
      />
      <div className="space-y-5">
        {checkout === 'success' && <InlineAlert tone="signal">{t('resellerPortal.checkoutSuccess')}</InlineAlert>}
        {checkout === 'cancelled' && <InlineAlert tone="signal">{t('resellerPortal.checkoutCancelled')}</InlineAlert>}
        {d.reseller.status === 'suspended' && <InlineAlert>{t('resellerPortal.suspended', { reason: d.reseller.suspended_reason ?? '—' })}</InlineAlert>}
        {d.reseller.status === 'active' && !d.access.has_access && <InlineAlert tone="signal">{t('resellerPortal.noAccess')}</InlineAlert>}
        {!admin && <InlineAlert tone="signal">{t('resellerPortal.memberNotice')}</InlineAlert>}
        {actionError && <InlineAlert>{actionError}</InlineAlert>}

        <Panel title={t('resellerPortal.plan', { plan: d.plan?.name ?? d.reseller.plan_code })}>
          {d.plan && <p className="text-sm">{t('resellerPortal.planDetail', { price: money(d.plan.monthly_price_cents, d.plan.currency), setup: money(d.plan.setup_fee_cents, d.plan.currency), orgs: d.access.max_organizations, domains: d.access.max_custom_domains })}</p>}
          <p className="mt-1 text-sm text-muted">
            {d.subscription ? t('resellerPortal.subscription', { status: `${d.subscription.status}${d.subscription.current_period_end ? ` · ${formatDate(d.subscription.current_period_end)}` : ''}${d.subscription.livemode ? '' : ' (test)'}` }) : t('resellerPortal.subscription', { status: '—' })}
          </p>
          {d.subscription?.source === 'external' && <p className="mt-1 text-xs text-muted">{t('resellerPortal.external')}</p>}
          {admin && (
            <div className="mt-3 flex flex-wrap gap-2">
              {!d.subscription && d.reseller.status === 'active' && <Button size="sm" loading={busy} onClick={() => void billing('billing-checkout')}>{t('resellerPortal.subscribe')}</Button>}
              {d.has_billing_account && <Button size="sm" variant="secondary" loading={busy} onClick={() => void billing('billing-portal')}>{t('resellerPortal.portal')}</Button>}
            </div>
          )}
          {admin && !d.subscription && <p className="mt-2 text-xs text-muted">{t('resellerPortal.subscribeHint')}</p>}
        </Panel>

        <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Kpi label={t('resellerPortal.clients')} value={t('resellerPortal.limit', { used: d.clients.length, limit: d.access.max_organizations })} />
          <Kpi label={t('resellerPortal.activeOrgs')} value={num(d.clients.filter((c) => c.admin_status === 'active').length)} />
          <Kpi label={t('resellerPortal.creditsUsed')} value={num(totals.used)} sub={`${t('resellerPortal.creditsAvailable')}: ${num(totals.avail)}`} />
          <Kpi label={t('resellerPortal.wholesale')} hint={t('resellerPortal.wholesaleHint')} value={money(totals.wholesale)} sub={t('resellerPortal.wholesaleHint')} />
        </section>

        <Panel title={t('resellerPortal.clients')}>
          <p className="mb-2 text-xs text-muted">{t('resellerPortal.privacy')}</p>
          <Table minWidth={720} head={[t('resellerPortal.colClient'), t('resellerPortal.colPlan'), t('resellerPortal.colUsers'), t('resellerPortal.colCredits'), t('resellerPortal.colLeads'), t('resellerPortal.colWholesale')]}>
            {d.clients.map((c) => (
              <tr key={c.organization_id}>
                <td className="py-2 pr-3">{c.name}{c.admin_status === 'suspended' && <Badge tone="danger" className="ml-2">suspended</Badge>}</td>
                <td className="py-2 pr-3">
                  {admin ? (
                    <select className={`${inputCls} w-auto capitalize`} value={c.client_plan_code} aria-label={t('resellerPortal.colPlan')}
                      onChange={async (e) => {
                        try {
                          await post('/api/reseller/client-plan', { reseller_id: d.reseller.id, organization_id: c.organization_id, client_plan_code: e.target.value })
                          void reload()
                        } catch (err) {
                          setActionError(consoleError(err, t))
                        }
                      }}>
                      {d.access.allowed_client_plans.map((p) => <option key={p} value={p}>{p}</option>)}
                    </select>
                  ) : <span className="capitalize">{c.client_plan_code}</span>}
                </td>
                <td className="tabular py-2 pr-3">{num(c.users)}</td>
                <td className="tabular py-2 pr-3">{num(c.credits_used)} / {num(c.credits_limit)}</td>
                <td className="tabular py-2 pr-3">{num(c.leads_used)} / {num(c.leads_limit)}</td>
                <td className="tabular py-2">{money(c.wholesale_cents)}</td>
              </tr>
            ))}
          </Table>
          {d.clients.length === 0 && <p className="py-3 text-sm text-muted">{t('console.none')}</p>}
        </Panel>

        {admin && <Invitations d={d} onChanged={() => void reload()} />}
        <Domains d={d} onChanged={() => void reload()} />
        <p className="text-sm"><Link className="text-flow hover:underline" to="/reseller/branding">{t('resellerPortal.editBranding')} →</Link></p>
      </div>
    </>
  )
}
