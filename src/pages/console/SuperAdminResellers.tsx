import { useState, type FormEvent } from 'react'
import { useI18n } from '../../i18n'
import { PageHeader } from '../../components/ui/PageHeader'
import { Panel } from '../../components/ui/Panel'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { Dialog } from '../../components/ui/Dialog'
import { ErrorState, InlineAlert, LoadingState } from '../../components/ui/States'
import { ReasonDialog, Table, consoleError, inputCls, post, useApi, useFormatters } from '../../features/console/shared'

interface Access { has_access: boolean; reason: string; max_organizations: number; max_custom_domains: number; subscription_source: string | null }
interface Reseller {
  id: string
  name: string
  slug: string
  status: 'active' | 'suspended'
  plan_code: string
  contact_email: string | null
  suspended_reason: string | null
  wholesale_prices: Record<string, number>
  max_organizations_override: number | null
  max_custom_domains_override: number | null
  access: Access
  subscription: { source: string; status: string; current_period_end: string | null; livemode: boolean } | null
  organizations_active: number
  invitations_pending: number
  domains_active: number
  domains_total: number
  wholesale_monthly_cents: number
  credits_used_month: number
  members: { email: string; role: string }[]
  organizations: { id: string; name: string; client_plan_code: string; admin_status: string }[]
}
interface Domain { id: string; hostname: string; reseller_id: string; status: string; dns_status: string; https_status: string; provisioning: string; last_error: string | null }
interface Plan { code: string; name: string; setup_fee_cents: number; monthly_price_cents: number; max_organizations: number; max_custom_domains: number }
interface Data { resellers: Reseller[]; domains: Domain[]; plans: Plan[] }

const CLIENT_PLANS = ['starter', 'business', 'enterprise'] as const

function CreateReseller({ plans, onCreated }: { plans: Plan[]; onCreated: () => void }) {
  const { t } = useI18n()
  const [f, setF] = useState({ name: '', slug: '', plan_code: plans[0]?.code ?? 'agency', admin_email: '', contact_email: '', max_organizations: '' })
  const [prices, setPrices] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })
  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const wholesale = Object.fromEntries(Object.entries(prices).filter(([, v]) => v.trim() !== '').map(([k, v]) => [k, Math.round(Number(v))]))
      await post('/api/super-admin/reseller-create', { ...f, contact_email: f.contact_email || null, max_organizations: f.max_organizations ? Number(f.max_organizations) : null, wholesale_prices: wholesale })
      setF({ ...f, name: '', slug: '', admin_email: '', contact_email: '', max_organizations: '' })
      setPrices({})
      onCreated()
    } catch (err) {
      setError(consoleError(err, t))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Panel title={t('saResellers.create')}>
      <form onSubmit={submit} className="grid gap-3 text-sm md:grid-cols-3">
        <label>{t('saResellers.name')}<input className={inputCls} required minLength={2} maxLength={120} value={f.name} onChange={set('name')} /></label>
        <label>{t('saResellers.slug')}<input className={inputCls} required pattern="[a-z0-9][a-z0-9-]{1,40}" value={f.slug} onChange={set('slug')} /></label>
        <label>{t('saResellers.plan')}
          <select className={inputCls} value={f.plan_code} onChange={set('plan_code')}>
            {plans.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}
          </select>
        </label>
        <label>{t('saResellers.adminEmail')}<input className={inputCls} type="email" required value={f.admin_email} onChange={set('admin_email')} /></label>
        <label>{t('saResellers.contactEmail')}<input className={inputCls} type="email" value={f.contact_email} onChange={set('contact_email')} /></label>
        <label>{t('saResellers.maxOrgs')}<input className={inputCls} type="number" min={0} value={f.max_organizations} onChange={set('max_organizations')} /></label>
        <fieldset className="md:col-span-3">
          <legend>{t('saResellers.wholesale')}</legend>
          <div className="mt-1 grid gap-2 sm:grid-cols-3">
            {CLIENT_PLANS.map((p) => (
              <label key={p} className="capitalize">{p}<input className={inputCls} type="number" min={0} value={prices[p] ?? ''} onChange={(e) => setPrices({ ...prices, [p]: e.target.value })} /></label>
            ))}
          </div>
        </fieldset>
        {error && <p className="text-danger md:col-span-3">{error}</p>}
        <div className="md:col-span-3"><Button type="submit" loading={busy}>{t('saResellers.createBtn')}</Button></div>
      </form>
    </Panel>
  )
}

function Manage({ r, domains, plans, onClose, onChanged }: { r: Reseller; domains: Domain[]; plans: Plan[]; onClose: () => void; onChanged: () => void }) {
  const { t } = useI18n()
  const [pending, setPending] = useState<null | { title: string; danger?: boolean; run: (reason: string) => Promise<unknown> }>(null)
  const [plan, setPlan] = useState(r.plan_code)
  const [maxOrgs, setMaxOrgs] = useState(r.max_organizations_override?.toString() ?? '')
  const [maxDomains, setMaxDomains] = useState(r.max_custom_domains_override?.toString() ?? '')
  const [prices, setPrices] = useState<Record<string, string>>(Object.fromEntries(Object.entries(r.wholesale_prices).map(([k, v]) => [k, String(v)])))
  const [member, setMember] = useState({ email: '', role: 'reseller_member' })
  const ask = (title: string, run: (reason: string) => Promise<unknown>, danger = false) => setPending({ title, run, danger })
  const done = async (p: Promise<unknown>) => {
    await p
    onChanged()
  }

  return (
    <Dialog open onClose={onClose} variant="drawer" title={r.name} closeLabel={t('console.close')}>
      <div className="space-y-5 text-sm">
        {r.status === 'suspended' && <InlineAlert>{r.suspended_reason}</InlineAlert>}
        <div className="flex flex-wrap gap-2">
          {r.status === 'active' ? (
            <Button size="sm" variant="danger" onClick={() => ask(t('saResellers.suspend'), (reason) => done(post('/api/super-admin/reseller-status', { reseller_id: r.id, action: 'suspend', reason })), true)}>{t('saResellers.suspend')}</Button>
          ) : (
            <Button size="sm" onClick={() => ask(t('saResellers.reactivate'), (reason) => done(post('/api/super-admin/reseller-status', { reseller_id: r.id, action: 'reactivate', reason })))}>{t('saResellers.reactivate')}</Button>
          )}
          {r.access.subscription_source === 'external' ? (
            <Button size="sm" variant="secondary" onClick={() => ask(t('saResellers.externalOff'), (reason) => done(post('/api/super-admin/reseller-external-billing', { reseller_id: r.id, active: false, reason })), true)}>{t('saResellers.externalOff')}</Button>
          ) : (
            <Button size="sm" variant="secondary" onClick={() => ask(t('saResellers.externalOn'), (reason) => done(post('/api/super-admin/reseller-external-billing', { reseller_id: r.id, active: true, reason })))}>{t('saResellers.externalOn')}</Button>
          )}
        </div>
        <p className="text-xs text-muted">{t('saResellers.externalHint')}</p>

        <section className="space-y-2">
          <h3 className="font-semibold">{t('saResellers.limits')}</h3>
          <label className="block">{t('saResellers.plan')}
            <select className={inputCls} value={plan} onChange={(e) => setPlan(e.target.value)}>{plans.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}</select>
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label>{t('saResellers.maxOrgs')}<input className={inputCls} type="number" min={0} value={maxOrgs} onChange={(e) => setMaxOrgs(e.target.value)} /></label>
            <label>{t('saResellers.maxDomains')}<input className={inputCls} type="number" min={0} max={50} value={maxDomains} onChange={(e) => setMaxDomains(e.target.value)} /></label>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {CLIENT_PLANS.map((p) => <label key={p} className="capitalize">{p}<input className={inputCls} type="number" min={0} value={prices[p] ?? ''} onChange={(e) => setPrices({ ...prices, [p]: e.target.value })} /></label>)}
          </div>
          <Button size="sm" variant="secondary" onClick={() => ask(t('saResellers.saveLimits'), (reason) => done(post('/api/super-admin/reseller-update', {
            reseller_id: r.id, reason,
            patch: {
              plan_code: plan,
              max_organizations_override: maxOrgs === '' ? null : Number(maxOrgs),
              max_custom_domains_override: maxDomains === '' ? null : Number(maxDomains),
              wholesale_prices: Object.fromEntries(Object.entries(prices).filter(([, v]) => v.trim() !== '').map(([k, v]) => [k, Math.round(Number(v))])),
            },
          })))}>{t('saResellers.saveLimits')}</Button>
        </section>

        <section>
          <h3 className="font-semibold">{t('saResellers.members')}</h3>
          <ul className="mt-1 divide-y divide-line">
            {r.members.map((m) => (
              <li key={m.email} className="flex items-center justify-between gap-2 py-1.5">
                <span>{m.email} <span className="text-xs text-muted">{m.role}</span></span>
                <Button size="sm" variant="ghost" onClick={() => ask(t('saResellers.removeMember'), (reason) => done(post('/api/super-admin/reseller-member', { reseller_id: r.id, email: m.email, role: null, reason })), true)}>{t('saResellers.removeMember')}</Button>
              </li>
            ))}
          </ul>
          <div className="mt-2 flex gap-2">
            <input className={inputCls} type="email" placeholder={t('saResellers.memberEmail')} value={member.email} onChange={(e) => setMember({ ...member, email: e.target.value })} />
            <select className={`${inputCls} w-auto`} value={member.role} onChange={(e) => setMember({ ...member, role: e.target.value })} aria-label={t('saResellers.role')}>
              <option value="reseller_member">reseller_member</option>
              <option value="reseller_admin">reseller_admin</option>
            </select>
            <Button size="sm" variant="secondary" disabled={!member.email} onClick={() => ask(t('saResellers.addMember'), (reason) => done(post('/api/super-admin/reseller-member', { reseller_id: r.id, email: member.email, role: member.role, reason })))}>{t('saResellers.addMember')}</Button>
          </div>
        </section>

        <section>
          <h3 className="font-semibold">{t('saResellers.organizations')}</h3>
          <ul className="mt-1 divide-y divide-line">
            {r.organizations.map((o) => <li key={o.id} className="flex justify-between py-1.5"><span>{o.name}</span><span className="capitalize text-muted">{o.client_plan_code} · {o.admin_status}</span></li>)}
            {r.organizations.length === 0 && <li className="py-1.5 text-muted">{t('console.none')}</li>}
          </ul>
        </section>

        <section>
          <h3 className="font-semibold">{t('saResellers.domains')}</h3>
          <p className="text-xs text-muted">{t('saResellers.provisioningHint')}</p>
          <ul className="mt-1 divide-y divide-line">
            {domains.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                <span><span className="font-mono">{d.hostname}</span> <Badge tone={d.status === 'active' ? 'ok' : d.status === 'verified' ? 'flow' : 'neutral'}>{d.status}</Badge> <span className="text-xs text-muted">{d.dns_status} · {d.https_status}</span></span>
                {d.provisioning === 'manual_done' ? (
                  <Button size="sm" variant="ghost" onClick={() => ask(t('saResellers.unmarkProvisioned'), (reason) => done(post('/api/super-admin/domain-provisioned', { domain_id: d.id, done: false, reason })), true)}>{t('saResellers.unmarkProvisioned')}</Button>
                ) : (
                  <Button size="sm" variant="secondary" disabled={!['verified', 'active'].includes(d.status)} onClick={() => ask(t('saResellers.markProvisioned'), (reason) => done(post('/api/super-admin/domain-provisioned', { domain_id: d.id, done: true, reason })))}>{t('saResellers.markProvisioned')}</Button>
                )}
              </li>
            ))}
            {domains.length === 0 && <li className="py-1.5 text-muted">{t('console.none')}</li>}
          </ul>
        </section>
      </div>
      <ReasonDialog open={pending !== null} title={pending?.title ?? ''} danger={pending?.danger} onClose={() => setPending(null)} onConfirm={async (reason) => { await pending?.run(reason) }} />
    </Dialog>
  )
}

export default function SuperAdminResellers() {
  const { t } = useI18n()
  const { money, num } = useFormatters()
  const { data, error, loading, reload } = useApi<Data>('/api/super-admin/resellers')
  const [open, setOpen] = useState<string | null>(null)
  if (loading && !data) return <LoadingState />
  if (error || !data) return <ErrorState message={t('console.loadError')} onRetry={() => void reload()} />
  const current = data.resellers.find((r) => r.id === open)
  return (
    <>
      <PageHeader title={t('saResellers.title')} />
      <div className="space-y-5">
        <CreateReseller plans={data.plans} onCreated={() => void reload()} />
        <Panel title={t('saResellers.title')}>
          <Table minWidth={880} head={[t('saResellers.colName'), t('saResellers.colPlan'), t('saResellers.colStatus'), t('saResellers.colSub'), t('saResellers.colClients'), t('saResellers.colWholesale'), t('saResellers.colCredits'), '']}>
            {data.resellers.map((r) => (
              <tr key={r.id}>
                <td className="py-2 pr-3"><span className="font-medium">{r.name}</span><span className="block text-xs text-muted">{r.slug}</span></td>
                <td className="py-2 pr-3 capitalize">{r.plan_code}</td>
                <td className="py-2 pr-3"><Badge tone={r.access.has_access ? 'ok' : r.status === 'suspended' ? 'danger' : 'signal'}>{t(`saResellers.access.${r.access.reason}`)}</Badge></td>
                <td className="py-2 pr-3 text-xs">{r.subscription ? `${r.subscription.source} · ${r.subscription.status}${r.subscription.livemode ? '' : ' (test)'}` : '—'}</td>
                <td className="tabular py-2 pr-3">{num(r.organizations_active)} / {num(r.access.max_organizations)}{r.invitations_pending ? ` (+${r.invitations_pending})` : ''}</td>
                <td className="tabular py-2 pr-3">{money(r.wholesale_monthly_cents)}</td>
                <td className="tabular py-2 pr-3">{num(r.credits_used_month)}</td>
                <td className="py-2"><Button size="sm" variant="ghost" onClick={() => setOpen(r.id)}>{t('saResellers.manage')}</Button></td>
              </tr>
            ))}
          </Table>
          {data.resellers.length === 0 && <p className="py-4 text-sm text-muted">{t('console.none')}</p>}
        </Panel>
      </div>
      {current && <Manage key={current.id + JSON.stringify(current.access)} r={current} plans={data.plans} domains={data.domains.filter((d) => d.reseller_id === current.id)} onClose={() => setOpen(null)} onChanged={() => void reload()} />}
    </>
  )
}
