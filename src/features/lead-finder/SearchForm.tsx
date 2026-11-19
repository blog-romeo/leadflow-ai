import { useMemo, useState, type FormEvent } from 'react'
import { Search } from 'lucide-react'
import { useI18n } from '../../i18n'
import { Field, Select } from '../../components/ui/Field'
import { Button } from '../../components/ui/Button'
import { COUNTRIES } from '../../config/countries'
import { cn } from '../../lib/cn'
import type { ProviderInfo } from './types'

export interface SearchFormValues {
  provider: ProviderInfo['id']
  sector: string
  location: string
  country: string
  keywords: string
  max_results: number
  website_filter: 'any' | 'with' | 'without'
}

const SIZES = [10, 20, 50, 100]

export function SearchForm({ providers, busy, onSubmit }: { providers: ProviderInfo[]; busy: boolean; onSubmit: (v: SearchFormValues) => void }) {
  const { t, locale } = useI18n()
  const configured = providers.filter((p) => p.configured)
  const [v, setV] = useState<SearchFormValues>({
    provider: configured[0]?.id ?? providers[0]?.id ?? 'osm_overpass',
    sector: '',
    location: '',
    country: 'IT',
    keywords: '',
    max_results: 20,
    website_filter: 'any',
  })
  const [errors, setErrors] = useState<{ sector?: string; location?: string }>({})
  const provider = useMemo(() => providers.find((p) => p.id === v.provider), [providers, v.provider])
  const set = <K extends keyof SearchFormValues>(k: K, value: SearchFormValues[K]) => setV((s) => ({ ...s, [k]: value }))

  function submit(e: FormEvent) {
    e.preventDefault()
    const next = {
      sector: v.sector.trim().length < 2 ? t('leadFinder.minChars') : undefined,
      location: v.location.trim().length < 2 ? t('leadFinder.minChars') : undefined,
    }
    setErrors(next)
    if (next.sector || next.location || !provider?.configured) return
    onSubmit({ ...v, max_results: Math.min(v.max_results, provider.capabilities.maxResults) })
  }

  const wf = [
    { value: 'any' as const, label: t('leadFinder.wfAny'), ok: true },
    { value: 'with' as const, label: t('leadFinder.wfWith'), ok: !!provider?.capabilities.websiteFilterWith },
    { value: 'without' as const, label: t('leadFinder.wfWithout'), ok: !!provider?.capabilities.websiteFilterWithout },
  ]

  return (
    <form onSubmit={submit} noValidate className="rounded-[var(--radius-panel)] border border-line bg-surface" aria-labelledby="search-title">
      <h2 id="search-title" className="border-b border-line px-5 py-3 text-base font-semibold">
        {t('leadFinder.formTitle')}
      </h2>
      <div className="grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-3">
        <fieldset className="sm:col-span-2 lg:col-span-3">
          <legend className="mb-1.5 text-sm font-medium">{t('leadFinder.provider')}</legend>
          <div className="flex flex-wrap gap-2">
            {providers.map((p) => (
              <label
                key={p.id}
                className={cn(
                  'flex cursor-pointer items-center gap-2 rounded-[var(--radius-control)] border px-3 py-2 text-sm has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-flow/40',
                  v.provider === p.id ? 'border-flow bg-flow-soft text-flow' : 'border-line',
                  !p.configured && 'cursor-not-allowed opacity-55',
                )}
              >
                <input type="radio" name="provider" value={p.id} className="sr-only" checked={v.provider === p.id} disabled={!p.configured} onChange={() => set('provider', p.id)} />
                {p.label}
                {!p.configured && <span className="text-xs">({t('leadFinder.configRequired')})</span>}
              </label>
            ))}
          </div>
        </fieldset>
        <Field label={t('leadFinder.sector')} placeholder={t('leadFinder.sectorPh')} value={v.sector} onChange={(e) => set('sector', e.target.value)} error={errors.sector} maxLength={80} required />
        <Field label={t('leadFinder.location')} placeholder={t('leadFinder.locationPh')} value={v.location} onChange={(e) => set('location', e.target.value)} error={errors.location} maxLength={120} required />
        <Select label={t('leadFinder.country')} value={v.country} onChange={(e) => set('country', e.target.value)}>
          {COUNTRIES.map((c) => (
            <option key={c.code} value={c.code}>
              {c.name[locale]}
            </option>
          ))}
        </Select>
        <Field
          label={t('leadFinder.keywords')}
          placeholder={t('leadFinder.keywordsPh')}
          value={v.keywords}
          onChange={(e) => set('keywords', e.target.value)}
          hint={provider?.capabilities.keywordFiltering ? t('leadFinder.keywordsHintGoogle') : t('leadFinder.keywordsHintOsm')}
          maxLength={200}
        />
        <Select label={t('leadFinder.maxResults')} value={v.max_results} onChange={(e) => set('max_results', Number(e.target.value))}>
          {SIZES.filter((n) => !provider || n <= provider.capabilities.maxResults || n === SIZES[0]).map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </Select>
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium">{t('leadFinder.websiteFilter')}</legend>
          <div className="inline-flex flex-wrap gap-1 rounded-[var(--radius-control)] border border-line p-1">
            {wf.map((o) => (
              <label
                key={o.value}
                title={o.ok ? undefined : t('leadFinder.wfUnsupported')}
                className={cn(
                  'cursor-pointer rounded-md px-2.5 py-1 text-sm has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-flow/40',
                  v.website_filter === o.value ? 'bg-flow-soft font-medium text-flow' : 'text-muted',
                  !o.ok && 'cursor-not-allowed opacity-50',
                )}
              >
                <input type="radio" name="website_filter" className="sr-only" value={o.value} checked={v.website_filter === o.value} disabled={!o.ok} onChange={() => set('website_filter', o.value)} />
                {o.label}
              </label>
            ))}
          </div>
        </fieldset>
      </div>
      <div className="flex justify-end border-t border-line px-5 py-3">
        <Button type="submit" size="lg" loading={busy} disabled={!provider?.configured}>
          {!busy && <Search className="size-4" aria-hidden />}
          {t('leadFinder.submit')}
        </Button>
      </div>
    </form>
  )
}
