import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { CalendarPlus, ExternalLink, ShieldCheck, Sparkles } from 'lucide-react'
import { useI18n } from '../../i18n'
import { supabase } from '../../lib/supabase'
import type { AppointmentRow, LeadAnalysisRow, SalesOpportunityRow, SalesProfileRow } from '../../lib/database.types'
import { Panel } from '../../components/ui/Panel'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { Field, Select } from '../../components/ui/Field'
import { InlineAlert, LoadingState } from '../../components/ui/States'
import { salesErrorMessage } from './errors'
import { startGeneration, useJob } from './jobs'
import { JobBanner } from './JobBanner'
import { useMoney } from './ProposalBuilder'

// ════════════════════════════════════════════════════════════════════════════
// Contattabilità e base giuridica
// ════════════════════════════════════════════════════════════════════════════
export function ComplianceCard({ source, contactStatus, contactable }: { source: { name: string; legal_basis: string } | null; contactStatus: string; contactable: boolean }) {
  const { t } = useI18n()
  return (
    <Panel title={t('sales.lead.complianceTitle')}>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
        <dt className="text-muted">{t('sales.lead.source')}</dt>
        <dd>{source?.name ?? '—'}</dd>
        <dt className="text-muted">{t('sales.lead.legalBasis')}</dt>
        <dd>{source ? t(`leadFinder.csv.basis.${source.legal_basis}`) : '—'}</dd>
        <dt className="text-muted">{t('sales.lead.contactStatus')}</dt>
        <dd>
          <Badge tone={contactable ? 'ok' : 'danger'}>{t(`status.${contactStatus}`)}</Badge>
        </dd>
      </dl>
      <p className="mt-3 flex gap-2 text-xs text-muted">
        <ShieldCheck className="size-4 shrink-0 text-flow" aria-hidden />
        {contactable ? t('sales.lead.publicEmailNote') : t('sales.lead.blockedNote')}
      </p>
      <p className="mt-2 text-xs text-muted">{t('sales.noSendNote')}</p>
    </Panel>
  )
}

// ════════════════════════════════════════════════════════════════════════════
// AI Lead Intelligence (+ analisi del Business Analyzer dal Lead Finder)
// ════════════════════════════════════════════════════════════════════════════
type Intel = {
  fit_summary: string
  verified_data: { statement: string; source: string }[]
  hypotheses: { statement: string; rationale: string }[]
  opportunities: { title: string; rationale: string; basis: 'verified' | 'hypothesis' }[]
  recommended_service_id: string | null
  recommended_service_name: string | null
  recommended_service_reason: string
  commercial_rationale: string
  operational_priority: 'high' | 'medium' | 'low'
  priority_reason: string
  missing_information: string[]
  next_best_action: { type: string; description: string }
  analyzed_at: string
  model: string
}
type Finder = {
  sector?: { value: string; basis: string }
  activity_description?: { value: string; basis: string }
  verified_facts?: { statement: string; evidence: string }[]
  digital_needs?: { need: string; rationale: string }[]
  qualification_reason?: string
  analyzed_at?: string
}

function List({ title, items }: { title: string; items: React.ReactNode[] }) {
  if (!items.length) return null
  return (
    <div>
      <h4 className="text-sm font-semibold">{title}</h4>
      <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">{items.map((x, i) => <li key={i}>{x}</li>)}</ul>
    </div>
  )
}

export function IntelligencePanel({ orgId, leadId, aiReady, profileComplete, onCreateOpportunity }: { orgId: string; leadId: string; aiReady: boolean; profileComplete: boolean; onCreateOpportunity: (serviceName: string) => void }) {
  const { t, formatDate } = useI18n()
  const [intel, setIntel] = useState<Intel | null>(null)
  const [finder, setFinder] = useState<Finder | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [jobId, setJobId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!supabase) return
    const { data } = await supabase.from('lead_analyses').select('kind, data, created_at').eq('organization_id', orgId).eq('lead_id', leadId).order('created_at', { ascending: false }).limit(10)
    const rows = (data ?? []) as Pick<LeadAnalysisRow, 'kind' | 'data'>[]
    setIntel((rows.find((r) => r.kind === 'sales_intelligence')?.data as unknown as Intel) ?? null)
    setFinder((rows.find((r) => r.kind === 'business_analysis')?.data as unknown as Finder) ?? null)
    setLoaded(true)
  }, [orgId, leadId])

  useEffect(() => {
    void load()
  }, [load])
  const { job, running } = useJob(jobId, () => void load())

  async function generate() {
    setError(null)
    try {
      setJobId((await startGeneration(orgId, { task: 'intelligence', lead_id: leadId })).job_id)
    } catch (err) {
      setError(salesErrorMessage(err, t))
    }
  }

  if (!loaded) return <LoadingState />
  const prioTone = { high: 'ok', medium: 'signal', low: 'neutral' } as const
  return (
    <div className="space-y-4">
      <Panel
        title={t('sales.intelligence.title')}
        action={
          <Button size="sm" onClick={() => void generate()} loading={running} disabled={!aiReady || !profileComplete}>
            <Sparkles className="size-4" aria-hidden />
            {intel ? t('sales.intelligence.regenerate') : t('sales.intelligence.generate')}
          </Button>
        }
      >
        <div className="space-y-4">
          <JobBanner job={job} />
          {error && <InlineAlert>{error}</InlineAlert>}
          {!intel ? (
            <p className="text-sm text-muted">{t('sales.intelligence.none')}</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm text-muted">{t('sales.intelligence.priority')}:</span>
                <Badge tone={prioTone[intel.operational_priority]}>{t(`leadFinder.priority.${intel.operational_priority}`)}</Badge>
                <span className="text-sm">{intel.priority_reason}</span>
              </div>
              <div>
                <h4 className="text-sm font-semibold">{t('sales.intelligence.fit')}</h4>
                <p className="mt-1 text-sm">{intel.fit_summary}</p>
              </div>
              <div className="rounded-[var(--radius-control)] border border-line p-3">
                <h4 className="text-sm font-semibold">{t('sales.intelligence.recommended')}</h4>
                {intel.recommended_service_name ? (
                  <>
                    <p className="mt-1 text-sm font-medium text-flow">{intel.recommended_service_name}</p>
                    <p className="mt-0.5 text-sm">{intel.recommended_service_reason}</p>
                    <Button size="sm" variant="secondary" className="mt-2" onClick={() => onCreateOpportunity(intel.recommended_service_name!)}>
                      {t('sales.intelligence.createOpportunity')}
                    </Button>
                  </>
                ) : (
                  <p className="mt-1 text-sm text-muted">{t('sales.intelligence.noService')}</p>
                )}
              </div>
              <div>
                <h4 className="text-sm font-semibold">{t('sales.intelligence.rationale')}</h4>
                <p className="mt-1 text-sm">{intel.commercial_rationale}</p>
              </div>
              <List title={t('sales.intelligence.verified')} items={intel.verified_data.map((v) => <>{v.statement} <span className="text-xs text-muted">({v.source})</span></>)} />
              <List
                title={t('sales.intelligence.opportunities')}
                items={intel.opportunities.map((o) => (
                  <>
                    <span className="font-medium">{o.title}</span> — {o.rationale}{' '}
                    <Badge tone={o.basis === 'verified' ? 'ok' : 'signal'}>{t(`leadFinder.details.basis.${o.basis}`)}</Badge>
                  </>
                ))}
              />
              <List title={t('sales.intelligence.hypotheses')} items={intel.hypotheses.map((h) => <>{h.statement} <span className="text-muted">— {h.rationale}</span></>)} />
              <List title={t('sales.intelligence.missing')} items={intel.missing_information} />
              <p className="text-sm">
                <span className="font-semibold">{t('sales.intelligence.nextAction')}: </span>
                {t(`sales.intelligence.actions.${intel.next_best_action.type}`)} — {intel.next_best_action.description}
              </p>
              <p className="text-xs text-muted">{t('sales.intelligence.generatedAt', { date: formatDate(intel.analyzed_at), model: intel.model })}</p>
            </>
          )}
        </div>
      </Panel>
      <Panel title={t('sales.lead.analysisFromFinder')}>
        {!finder ? (
          <p className="text-sm text-muted">{t('sales.lead.noFinderAnalysis')}</p>
        ) : (
          <div className="space-y-3">
            {finder.activity_description?.value && <p className="text-sm">{finder.activity_description.value}</p>}
            <List title={t('leadFinder.details.verifiedFacts')} items={(finder.verified_facts ?? []).map((f) => <>{f.statement}: <span className="text-muted">“{f.evidence}”</span></>)} />
            <List title={t('leadFinder.details.digitalNeeds')} items={(finder.digital_needs ?? []).map((d) => <>{d.need} <span className="text-muted">— {d.rationale}</span></>)} />
            {finder.qualification_reason && <p className="text-sm text-muted">{finder.qualification_reason}</p>}
          </div>
        )}
      </Panel>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════════
// Opportunità
// ════════════════════════════════════════════════════════════════════════════
export function OpportunityCard({ orgId, leadId, companyName, profile, prefill, onChanged }: { orgId: string; leadId: string; companyName: string; profile: SalesProfileRow | null; prefill: string | null; onChanged: () => void }) {
  const { t, formatDate } = useI18n()
  const [opp, setOpp] = useState<SalesOpportunityRow | null | undefined>(undefined)
  const [form, setForm] = useState<{ title: string; service: string; value: string; date: string } | null>(null)
  const [msg, setMsg] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null)
  const money = useMoney(profile?.currency ?? 'EUR')

  const load = useCallback(async () => {
    if (!supabase) return
    const { data } = await supabase.from('sales_opportunities').select('*').eq('organization_id', orgId).eq('lead_id', leadId).order('created_at', { ascending: false }).limit(1).maybeSingle()
    setOpp((data as SalesOpportunityRow | null) ?? null)
  }, [orgId, leadId])
  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    if (prefill) setForm({ title: `${prefill} · ${companyName}`.slice(0, 200), service: prefill, value: '', date: '' })
  }, [prefill, companyName])

  async function create(e: FormEvent) {
    e.preventDefault()
    if (!supabase || !form || form.title.trim().length < 2) return
    const value = form.value ? Number(form.value.replace(',', '.')) : null
    const { error } = await supabase.from('sales_opportunities').insert({
      organization_id: orgId,
      lead_id: leadId,
      title: form.title.trim(),
      service_name: form.service || null,
      value_amount: value !== null && Number.isFinite(value) && value >= 0 ? value : null,
      currency: profile?.currency ?? 'EUR',
      expected_close_date: form.date || null,
    })
    if (error) return setMsg({ tone: 'danger', text: salesErrorMessage(error, t) })
    setForm(null)
    setMsg({ tone: 'ok', text: t('sales.opportunity.created') })
    void load()
    onChanged()
  }

  return (
    <Panel title={t('sales.opportunity.title')}>
      <div className="space-y-3">
        {msg && <InlineAlert tone={msg.tone}>{msg.text}</InlineAlert>}
        {opp === undefined ? (
          <LoadingState />
        ) : opp && opp.status === 'open' && !form ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
            <dt className="text-muted">{t('sales.opportunity.name')}</dt>
            <dd className="font-medium">{opp.title}</dd>
            <dt className="text-muted">{t('sales.opportunity.service')}</dt>
            <dd>{opp.service_name ?? '—'}</dd>
            <dt className="text-muted">{t('sales.opportunity.value')}</dt>
            <dd className="tabular">{opp.value_amount != null ? money(Number(opp.value_amount)) : '—'}</dd>
            <dt className="text-muted">{t('sales.opportunity.expectedClose')}</dt>
            <dd>{opp.expected_close_date ? formatDate(opp.expected_close_date) : '—'}</dd>
          </dl>
        ) : form ? (
          <form onSubmit={create} className="space-y-3">
            <Field label={t('sales.opportunity.name')} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} maxLength={200} required />
            <Select label={t('sales.opportunity.service')} value={form.service} onChange={(e) => setForm({ ...form, service: e.target.value })}>
              <option value="">—</option>
              {(profile?.services ?? []).map((s) => (
                <option key={s.id} value={s.name}>
                  {s.name}
                </option>
              ))}
            </Select>
            <Field label={`${t('sales.opportunity.value')} (${profile?.currency ?? 'EUR'})`} inputMode="decimal" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} hint={t('sales.opportunity.valueHint')} />
            <Field label={t('sales.opportunity.expectedClose')} type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
            <div className="flex gap-2">
              <Button type="submit">{t('sales.opportunity.save')}</Button>
              <Button variant="ghost" onClick={() => setForm(null)}>
                {t('common.cancel')}
              </Button>
            </div>
          </form>
        ) : (
          <>
            {opp && <p className="text-sm">{opp.title} · <Badge tone={opp.status === 'won' ? 'ok' : 'neutral'}>{t(`sales.opportunity.status.${opp.status}`)}</Badge></p>}
            <p className="text-sm text-muted">{t('sales.opportunity.none')}</p>
            <Button size="sm" variant="secondary" onClick={() => setForm({ title: companyName, service: '', value: '', date: '' })}>
              {t('sales.opportunity.create')}
            </Button>
          </>
        )}
      </div>
    </Panel>
  )
}

// ════════════════════════════════════════════════════════════════════════════
// Appuntamenti
// ════════════════════════════════════════════════════════════════════════════
export function AppointmentsCard({ orgId, leadId, bookingUrl, onChanged }: { orgId: string; leadId: string; bookingUrl: string | null; onChanged: () => void }) {
  const { t, formatDate } = useI18n()
  const [rows, setRows] = useState<AppointmentRow[] | null>(null)
  const [form, setForm] = useState<{ title: string; start: string; minutes: string; location: string } | null>(null)
  const [msg, setMsg] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null)

  const load = useCallback(async () => {
    if (!supabase) return
    const { data } = await supabase.from('appointments').select('*').eq('organization_id', orgId).eq('lead_id', leadId).order('starts_at', { ascending: false }).limit(10)
    setRows((data ?? []) as AppointmentRow[])
  }, [orgId, leadId])
  useEffect(() => {
    void load()
  }, [load])

  async function create(e: FormEvent) {
    e.preventDefault()
    if (!supabase || !form || !form.start || form.title.trim().length < 2) return
    const start = new Date(form.start)
    const end = new Date(start.getTime() + Math.max(5, Number(form.minutes) || 30) * 60_000)
    const { error } = await supabase.from('appointments').insert({
      organization_id: orgId,
      lead_id: leadId,
      title: form.title.trim(),
      starts_at: start.toISOString(),
      ends_at: end.toISOString(),
      location: form.location.trim() || null,
    })
    if (error) return setMsg({ tone: 'danger', text: salesErrorMessage(error, t) })
    setForm(null)
    setMsg({ tone: 'ok', text: t('sales.appointment.created') })
    void load()
    onChanged()
  }

  return (
    <Panel
      title={t('sales.appointment.title')}
      action={
        bookingUrl ? (
          <a href={bookingUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sm text-flow hover:underline">
            {t('sales.appointment.bookingLink')} <ExternalLink className="size-3.5" aria-hidden />
          </a>
        ) : undefined
      }
    >
      <div className="space-y-3">
        {msg && <InlineAlert tone={msg.tone}>{msg.text}</InlineAlert>}
        {!rows ? (
          <LoadingState />
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted">{t('sales.appointment.none')}</p>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {rows.map((a) => (
              <li key={a.id} className="flex flex-wrap justify-between gap-2 py-2">
                <span className="font-medium">{a.title}</span>
                <span className="text-muted">
                  {formatDate(a.starts_at)} {new Date(a.starts_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  {a.location ? ` · ${a.location}` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
        {form ? (
          <form onSubmit={create} className="space-y-3">
            <Field label={t('sales.appointment.name')} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} maxLength={200} required />
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t('sales.appointment.start')} type="datetime-local" value={form.start} onChange={(e) => setForm({ ...form, start: e.target.value })} required />
              <Field label={t('sales.appointment.duration')} type="number" min={5} max={480} value={form.minutes} onChange={(e) => setForm({ ...form, minutes: e.target.value })} />
            </div>
            <Field label={t('sales.appointment.location')} value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} maxLength={300} />
            <div className="flex gap-2">
              <Button type="submit">{t('common.save')}</Button>
              <Button variant="ghost" onClick={() => setForm(null)}>
                {t('common.cancel')}
              </Button>
            </div>
          </form>
        ) : (
          <Button size="sm" variant="secondary" onClick={() => setForm({ title: '', start: '', minutes: '30', location: '' })}>
            <CalendarPlus className="size-4" aria-hidden />
            {t('sales.appointment.create')}
          </Button>
        )}
      </div>
    </Panel>
  )
}
