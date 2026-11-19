import { useEffect, useState, type FormEvent } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import { useI18n } from '../../i18n'
import { supabase } from '../../lib/supabase'
import { errorKey } from '../../lib/errors'
import type { OrganizationProfileRow } from '../../lib/database.types'
import { PageHeader } from '../../components/ui/PageHeader'
import { Panel } from '../../components/ui/Panel'
import { Field } from '../../components/ui/Field'
import { Button } from '../../components/ui/Button'
import { ErrorState, InlineAlert, LoadingState } from '../../components/ui/States'
import { cn } from '../../lib/cn'

const WEIGHTS = ['weight_sector', 'weight_geography', 'weight_icp', 'weight_signals', 'weight_completeness'] as const
const CRITERIA: Record<(typeof WEIGHTS)[number], string> = {
  weight_sector: 'sector',
  weight_geography: 'geography',
  weight_icp: 'icp',
  weight_signals: 'signals',
  weight_completeness: 'completeness',
}
const DEFAULTS = { weight_sector: 30, weight_geography: 20, weight_icp: 25, weight_signals: 15, weight_completeness: 10 }

const list = (s: string) => s.split(',').map((v) => v.trim()).filter(Boolean)

function Textarea({ label, value, onChange, placeholder, disabled }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; disabled?: boolean }) {
  const id = label.replace(/\W+/g, '-').toLowerCase()
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      <textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        maxLength={4000}
        rows={3}
        className="w-full rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-sm focus:border-flow focus:ring-2 focus:ring-flow/25 focus:outline-none disabled:opacity-60"
      />
    </div>
  )
}

/** Profilo commerciale (cliente ideale) e pesi dello scoring. Scrittura consentita da RLS solo agli admin. */
export default function LeadScoring() {
  const { t } = useI18n()
  const { currentOrg, isOrgAdmin, user } = useAuth()
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [form, setForm] = useState({ services: '', ideal: '', sectors: '', regions: '', countries: '', ...DEFAULTS })
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!supabase || !currentOrg) return
    supabase
      .from('organization_profiles')
      .select('*')
      .eq('organization_id', currentOrg.id)
      .maybeSingle()
      .then(({ data, error }) => {
        setLoading(false)
        if (error) return setLoadError(true)
        const p = data as OrganizationProfileRow | null
        if (p)
          setForm({
            services: p.services_description ?? '',
            ideal: p.ideal_customer ?? '',
            sectors: p.target_sectors.join(', '),
            regions: p.target_regions.join(', '),
            countries: p.target_countries.join(', '),
            weight_sector: p.weight_sector,
            weight_geography: p.weight_geography,
            weight_icp: p.weight_icp,
            weight_signals: p.weight_signals,
            weight_completeness: p.weight_completeness,
          })
      })
  }, [currentOrg])

  const sum = WEIGHTS.reduce((a, k) => a + (Number(form[k]) || 0), 0)
  const countries = list(form.countries).map((c) => c.toUpperCase())
  const countriesOk = countries.every((c) => /^[A-Z]{2}$/.test(c))

  async function submit(e: FormEvent) {
    e.preventDefault()
    setResult(null)
    if (sum !== 100 || !countriesOk || !supabase || !currentOrg) return
    setBusy(true)
    const { error } = await supabase
      .from('organization_profiles')
      .update({
        services_description: form.services.trim() || null,
        ideal_customer: form.ideal.trim() || null,
        target_sectors: list(form.sectors).slice(0, 30),
        target_regions: list(form.regions).slice(0, 50),
        target_countries: countries.slice(0, 30),
        weight_sector: form.weight_sector,
        weight_geography: form.weight_geography,
        weight_icp: form.weight_icp,
        weight_signals: form.weight_signals,
        weight_completeness: form.weight_completeness,
        updated_by: user?.id ?? null,
      })
      .eq('organization_id', currentOrg.id)
    setBusy(false)
    setResult(error ? { ok: false, msg: t(errorKey(error)) } : { ok: true, msg: t('common.saved') })
  }

  if (loading) return <LoadingState />
  if (loadError) return <ErrorState message={t('scoringSettings.loadError')} />

  return (
    <>
      <PageHeader title={t('scoringSettings.title')} subtitle={t('scoringSettings.subtitle')} />
      <form onSubmit={submit} className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <Panel title={t('scoringSettings.profileTitle')}>
          <div className="space-y-4">
            {!isOrgAdmin && <InlineAlert tone="signal">{t('scoringSettings.readOnly')}</InlineAlert>}
            <Textarea label={t('scoringSettings.services')} placeholder={t('scoringSettings.servicesPh')} value={form.services} onChange={(v) => setForm((f) => ({ ...f, services: v }))} disabled={!isOrgAdmin} />
            <Textarea label={t('scoringSettings.idealCustomer')} placeholder={t('scoringSettings.idealCustomerPh')} value={form.ideal} onChange={(v) => setForm((f) => ({ ...f, ideal: v }))} disabled={!isOrgAdmin} />
            <Field label={t('scoringSettings.targetSectors')} hint={t('scoringSettings.listHint')} value={form.sectors} onChange={(e) => setForm((f) => ({ ...f, sectors: e.target.value }))} disabled={!isOrgAdmin} placeholder="hotel, b&b" />
            <Field label={t('scoringSettings.targetRegions')} hint={t('scoringSettings.listHint')} value={form.regions} onChange={(e) => setForm((f) => ({ ...f, regions: e.target.value }))} disabled={!isOrgAdmin} placeholder="Roma, Firenze" />
            <Field
              label={t('scoringSettings.targetCountries')}
              hint={t('scoringSettings.listHint')}
              error={countriesOk ? null : t('scoringSettings.countriesInvalid')}
              value={form.countries}
              onChange={(e) => setForm((f) => ({ ...f, countries: e.target.value }))}
              disabled={!isOrgAdmin}
              placeholder="IT"
            />
          </div>
        </Panel>
        <Panel title={t('scoringSettings.weightsTitle')}>
          <div className="space-y-3">
            {WEIGHTS.map((k) => (
              <div key={k} className="grid grid-cols-[1fr_5rem] items-center gap-3">
                <label htmlFor={k} className="text-sm">
                  {t(`leadFinder.criteria.${CRITERIA[k]}`)}
                </label>
                <input
                  id={k}
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={100}
                  value={form[k]}
                  disabled={!isOrgAdmin}
                  onChange={(e) => setForm((f) => ({ ...f, [k]: Math.max(0, Math.min(100, Number(e.target.value) || 0)) }))}
                  className="h-10 w-full rounded-[var(--radius-control)] border border-line bg-surface px-3 text-right text-sm tabular focus:border-flow focus:outline-none disabled:opacity-60"
                />
              </div>
            ))}
            <p className={cn('text-sm font-medium tabular', sum === 100 ? 'text-ok' : 'text-danger')} aria-live="polite">
              {t('scoringSettings.weightsSum', { sum })} {sum !== 100 && `— ${t('scoringSettings.weightsInvalid')}`}
            </p>
            <p className="text-xs text-muted">{t('scoringSettings.thresholds')}</p>
            {isOrgAdmin && (
              <button type="button" className="text-sm text-flow hover:underline" onClick={() => setForm((f) => ({ ...f, ...DEFAULTS }))}>
                {t('scoringSettings.reset')}
              </button>
            )}
          </div>
        </Panel>
        {isOrgAdmin && (
          <div className="flex flex-wrap items-center gap-3 lg:col-span-2">
            <Button type="submit" loading={busy} disabled={sum !== 100 || !countriesOk}>
              {t('common.save')}
            </Button>
            {result && <InlineAlert tone={result.ok ? 'ok' : 'danger'}>{result.msg}</InlineAlert>}
          </div>
        )}
      </form>
    </>
  )
}
