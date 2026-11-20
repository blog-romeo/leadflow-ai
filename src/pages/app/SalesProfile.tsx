import { useEffect, useState, type FormEvent } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { useI18n } from '../../i18n'
import { supabase } from '../../lib/supabase'
import type { SalesProfileRow, SalesService, SalesTone } from '../../lib/database.types'
import { PageHeader } from '../../components/ui/PageHeader'
import { Panel } from '../../components/ui/Panel'
import { Field, Select } from '../../components/ui/Field'
import { Button } from '../../components/ui/Button'
import { ErrorState, InlineAlert, LoadingState } from '../../components/ui/States'
import { salesErrorMessage } from '../../features/sales/errors'

type ServiceForm = { id: string; name: string; description: string; price_from: string; price_to: string; price_unit: string }
const TONES: SalesTone[] = ['consultative', 'formal', 'friendly', 'direct']
const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean)
const num = (s: string) => (s.trim() === '' ? null : Number(s.replace(',', '.')))
const slug = (s: string, used: Set<string>) => {
  let base = s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'servizio'
  let id = base
  for (let i = 2; used.has(id); i++) id = `${base}-${i}`
  used.add(id)
  return id
}

function Area({ id, label, value, onChange, disabled, hint, rows = 3, placeholder }: { id: string; label: string; value: string; onChange: (v: string) => void; disabled: boolean; hint?: string; rows?: number; placeholder?: string }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      <textarea id={id} rows={rows} value={value} disabled={disabled} placeholder={placeholder} maxLength={4000} onChange={(e) => onChange(e.target.value)} aria-describedby={hint ? `${id}-hint` : undefined} className="w-full rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-sm focus:border-flow focus:ring-2 focus:ring-flow/25 focus:outline-none disabled:opacity-60" />
      {hint && <p id={`${id}-hint`} className="text-xs text-muted">{hint}</p>}
    </div>
  )
}

export default function SalesProfile() {
  const { t } = useI18n()
  const { currentOrg, isOrgAdmin, user } = useAuth()
  const [row, setRow] = useState<SalesProfileRow | null | undefined>(undefined)
  const [f, setF] = useState({ commercial_name: '', sector: '', website: '', offer_description: '', price_range: '', currency: 'EUR', served_areas: '', ideal_customer: '', differentiators: '', language: 'it', tone: 'consultative' as SalesTone, call_to_action: '', booking_url: '', commercial_terms: '', follow_up_days: '3, 7, 14' })
  const [services, setServices] = useState<ServiceForm[]>([])
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const ro = !isOrgAdmin

  useEffect(() => {
    if (!supabase || !currentOrg) return
    supabase
      .from('sales_profiles')
      .select('*')
      .eq('organization_id', currentOrg.id)
      .maybeSingle()
      .then(({ data, error }) => {
        if (error) return setRow(null)
        const p = data as unknown as SalesProfileRow
        setRow(p)
        if (!p) return
        setF({
          commercial_name: p.commercial_name ?? '',
          sector: p.sector ?? '',
          website: p.website ?? '',
          offer_description: p.offer_description ?? '',
          price_range: p.price_range ?? '',
          currency: p.currency,
          served_areas: p.served_areas.join(', '),
          ideal_customer: p.ideal_customer ?? '',
          differentiators: p.differentiators.join(', '),
          language: p.language,
          tone: p.tone,
          call_to_action: p.call_to_action ?? '',
          booking_url: p.booking_url ?? '',
          commercial_terms: p.commercial_terms ?? '',
          follow_up_days: p.follow_up_days.join(', '),
        })
        setServices(p.services.map((s) => ({ id: s.id, name: s.name, description: s.description ?? '', price_from: s.price_from?.toString() ?? '', price_to: s.price_to?.toString() ?? '', price_unit: s.price_unit ?? '' })))
      })
  }, [currentOrg])

  const set = (k: keyof typeof f) => (v: string) => setF((s) => ({ ...s, [k]: v }))

  async function submit(e: FormEvent) {
    e.preventDefault()
    setResult(null)
    const err: Record<string, string> = {}
    if (f.website && !/^https?:\/\/\S+$/i.test(f.website.trim())) err.website = t('sales.profile.invalidUrl')
    if (f.booking_url && !/^https:\/\/\S+$/i.test(f.booking_url.trim())) err.booking_url = t('sales.profile.invalidUrl')
    const days = f.follow_up_days.split(',').map((x) => Number(x.trim())).filter((x) => !Number.isNaN(x))
    if (!days.length || days.length > 6 || days.some((d, i) => !Number.isInteger(d) || d < 1 || d > 90 || (i > 0 && d <= days[i - 1]!))) err.follow_up_days = t('sales.profile.invalidDays')
    const used = new Set<string>()
    const svc: SalesService[] = []
    for (const s of services) {
      if (!s.name.trim() && !s.description.trim() && !s.price_from && !s.price_to) continue
      const pf = num(s.price_from)
      const pt = num(s.price_to)
      if (!s.name.trim() || (pf !== null && (!Number.isFinite(pf) || pf < 0)) || (pt !== null && (!Number.isFinite(pt) || pt < 0))) {
        err.services = t('sales.profile.invalidService')
        break
      }
      const id = /^[a-z0-9-]{1,40}$/.test(s.id) && !used.has(s.id) ? (used.add(s.id), s.id) : slug(s.name, used)
      svc.push({ id, name: s.name.trim().slice(0, 120), description: s.description.trim().slice(0, 1000) || null, price_from: pf, price_to: pt, price_unit: s.price_unit.trim().slice(0, 40) || null })
    }
    setErrors(err)
    if (Object.keys(err).length || !supabase || !currentOrg) return
    setBusy(true)
    const { error } = await supabase
      .from('sales_profiles')
      .update({
        commercial_name: f.commercial_name.trim() || null,
        sector: f.sector.trim() || null,
        website: f.website.trim() || null,
        offer_description: f.offer_description.trim() || null,
        services: svc,
        price_range: f.price_range.trim() || null,
        currency: f.currency,
        served_areas: list(f.served_areas).slice(0, 50),
        ideal_customer: f.ideal_customer.trim() || null,
        differentiators: list(f.differentiators).slice(0, 15),
        language: f.language as 'it' | 'en',
        tone: f.tone,
        call_to_action: f.call_to_action.trim() || null,
        booking_url: f.booking_url.trim() || null,
        commercial_terms: f.commercial_terms.trim() || null,
        follow_up_days: days,
        updated_by: user?.id ?? null,
      })
      .eq('organization_id', currentOrg.id)
    setBusy(false)
    setResult(error ? { ok: false, text: salesErrorMessage(error, t) } : { ok: true, text: t('common.saved') })
  }

  if (row === undefined) return <LoadingState />
  if (row === null) return <ErrorState message={t('sales.profile.loadError')} />
  const req = <span className="ml-1 text-xs font-normal text-signal">· {t('sales.profile.required')}</span>

  return (
    <>
      <PageHeader title={t('sales.profile.title')} subtitle={t('sales.profile.subtitle')} />
      <form onSubmit={submit} noValidate className="space-y-5">
        {ro && <InlineAlert tone="signal">{t('sales.profile.readOnly')}</InlineAlert>}
        <Panel title={t('sales.profile.sectionIdentity')}>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label={t('sales.profile.commercialName')} value={f.commercial_name} onChange={(e) => set('commercial_name')(e.target.value)} disabled={ro} maxLength={160} hint={t('sales.profile.required')} />
            <Field label={t('sales.profile.sector')} value={f.sector} onChange={(e) => set('sector')(e.target.value)} disabled={ro} maxLength={160} />
            <Field label={t('sales.profile.website')} type="url" value={f.website} onChange={(e) => set('website')(e.target.value)} disabled={ro} error={errors.website} placeholder="https://" />
          </div>
        </Panel>
        <Panel title={t('sales.profile.sectionOffer')}>
          <div className="space-y-4">
            <Area id="offer" label={t('sales.profile.offerDescription')} value={f.offer_description} onChange={set('offer_description')} disabled={ro} hint={t('sales.profile.required')} />
            <fieldset>
              <legend className="text-sm font-medium">
                {t('sales.profile.services')}
                {req}
              </legend>
              <p className="mt-0.5 text-xs text-muted">{t('sales.profile.servicesHint')}</p>
              {errors.services && (
                <p role="alert" className="mt-1 text-xs font-medium text-danger">
                  {errors.services}
                </p>
              )}
              <ul className="mt-3 space-y-3">
                {services.map((s, i) => {
                  const up = (k: keyof ServiceForm) => (e: React.ChangeEvent<HTMLInputElement>) => setServices((list_) => list_.map((x, j) => (j === i ? { ...x, [k]: e.target.value } : x)))
                  return (
                    <li key={i} className="grid gap-3 rounded-[var(--radius-control)] border border-line p-3 sm:grid-cols-[1.2fr_2fr_7rem_7rem_8rem_auto] sm:items-end">
                      <Field label={t('sales.profile.serviceName')} value={s.name} onChange={up('name')} disabled={ro} maxLength={120} />
                      <Field label={t('sales.profile.serviceDescription')} value={s.description} onChange={up('description')} disabled={ro} maxLength={1000} />
                      <Field label={t('sales.profile.priceFrom')} inputMode="decimal" value={s.price_from} onChange={up('price_from')} disabled={ro} />
                      <Field label={t('sales.profile.priceTo')} inputMode="decimal" value={s.price_to} onChange={up('price_to')} disabled={ro} />
                      <Field label={t('sales.profile.priceUnit')} placeholder={t('sales.profile.priceUnitPh')} value={s.price_unit} onChange={up('price_unit')} disabled={ro} maxLength={40} />
                      {!ro && (
                        <Button variant="ghost" onClick={() => setServices((l) => l.filter((_, j) => j !== i))} aria-label={t('sales.profile.removeService', { name: s.name || String(i + 1) })}>
                          <Trash2 className="size-4" aria-hidden />
                        </Button>
                      )}
                    </li>
                  )
                })}
              </ul>
              {!ro && services.length < 30 && (
                <Button variant="secondary" size="sm" className="mt-3" onClick={() => setServices((l) => [...l, { id: '', name: '', description: '', price_from: '', price_to: '', price_unit: '' }])}>
                  <Plus className="size-4" aria-hidden />
                  {t('sales.profile.addService')}
                </Button>
              )}
            </fieldset>
            <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
              <Field label={t('sales.profile.priceRange')} placeholder={t('sales.profile.priceRangePh')} value={f.price_range} onChange={(e) => set('price_range')(e.target.value)} disabled={ro} maxLength={200} />
              <Select label={t('sales.profile.currency')} value={f.currency} onChange={(e) => set('currency')(e.target.value)} disabled={ro}>
                {['EUR', 'CHF', 'GBP', 'USD'].map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </Select>
            </div>
          </div>
        </Panel>
        <Panel title={t('sales.profile.sectionMarket')}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('sales.profile.servedAreas')} hint={t('sales.profile.listHint')} value={f.served_areas} onChange={(e) => set('served_areas')(e.target.value)} disabled={ro} />
            <Field label={t('sales.profile.differentiators')} hint={t('sales.profile.listHint')} value={f.differentiators} onChange={(e) => set('differentiators')(e.target.value)} disabled={ro} />
            <div className="sm:col-span-2">
              <Area id="icp" label={t('sales.profile.idealCustomer')} value={f.ideal_customer} onChange={set('ideal_customer')} disabled={ro} />
            </div>
          </div>
        </Panel>
        <Panel title={t('sales.profile.sectionComms')}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Select label={t('sales.profile.language')} value={f.language} onChange={(e) => set('language')(e.target.value)} disabled={ro}>
              {(['it', 'en'] as const).map((l) => (
                <option key={l} value={l}>
                  {t(`sales.profile.languages.${l}`)}
                </option>
              ))}
            </Select>
            <Select label={t('sales.profile.tone')} value={f.tone} onChange={(e) => set('tone')(e.target.value)} disabled={ro}>
              {TONES.map((x) => (
                <option key={x} value={x}>
                  {t(`sales.profile.tones.${x}`)}
                </option>
              ))}
            </Select>
            <Field label={t('sales.profile.callToAction')} placeholder={t('sales.profile.callToActionPh')} value={f.call_to_action} onChange={(e) => set('call_to_action')(e.target.value)} disabled={ro} maxLength={300} hint={t('sales.profile.required')} />
            <Field label={t('sales.profile.bookingUrl')} type="url" placeholder="https://" value={f.booking_url} onChange={(e) => set('booking_url')(e.target.value)} disabled={ro} error={errors.booking_url} hint={t('sales.profile.bookingUrlHint')} />
          </div>
        </Panel>
        <Panel title={t('sales.profile.sectionTerms')}>
          <div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
            <Area id="terms" label={t('sales.profile.commercialTerms')} value={f.commercial_terms} onChange={set('commercial_terms')} disabled={ro} hint={t('sales.profile.commercialTermsHint')} />
            <Field label={t('sales.profile.followUpDays')} value={f.follow_up_days} onChange={(e) => set('follow_up_days')(e.target.value)} disabled={ro} error={errors.follow_up_days} hint={t('sales.profile.followUpDaysHint')} />
          </div>
        </Panel>
        {!ro && (
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" loading={busy}>
              {t('common.save')}
            </Button>
            {result && <InlineAlert tone={result.ok ? 'ok' : 'danger'}>{result.text}</InlineAlert>}
          </div>
        )}
      </form>
    </>
  )
}
