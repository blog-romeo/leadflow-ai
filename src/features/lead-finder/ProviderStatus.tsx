import { Check, ExternalLink, Minus, PlugZap, Sparkles } from 'lucide-react'
import { useI18n } from '../../i18n'
import { Badge } from '../../components/ui/Badge'
import { useAuth } from '../../contexts/AuthContext'
import type { ProvidersResponse } from './types'

function LicenseItem({ ok, label }: { ok: boolean; label: string }) {
  const { t } = useI18n()
  return (
    <li className="flex items-center gap-1.5">
      {ok ? <Check className="size-3.5 text-ok" aria-hidden /> : <Minus className="size-3.5 text-muted" aria-hidden />}
      <span className={ok ? '' : 'text-muted'}>
        {label}: {ok ? t('leadFinder.licAllowed') : t('leadFinder.licDenied')}
      </span>
    </li>
  )
}

/** Stato reale delle fonti: configurazione, diritti di licenza e note obbligatorie. */
export function ProviderStatus({ data }: { data: ProvidersResponse }) {
  const { t } = useI18n()
  const { isOrgAdmin } = useAuth()
  return (
    <section aria-labelledby="sources-title" className="rounded-[var(--radius-panel)] border border-line bg-surface">
      <h2 id="sources-title" className="border-b border-line px-5 py-3 text-base font-semibold">
        {t('leadFinder.sourcesTitle')}
      </h2>
      <ul className="divide-y divide-line">
        {data.providers.map((p) => (
          <li key={p.id} className="grid gap-2 px-5 py-3.5 sm:grid-cols-[1fr_auto] sm:items-start">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{p.label}</span>
                {p.configured ? <Badge tone="ok">{t('leadFinder.configured')}</Badge> : <Badge tone="signal">{t('leadFinder.configRequired')}</Badge>}
              </div>
              {!p.configured && (
                <p className="mt-1 text-xs text-muted">
                  {isOrgAdmin && p.missing.length ? t('leadFinder.configMissing', { vars: p.missing.join(', ') }) : t('leadFinder.configAskAdmin')}
                </p>
              )}
              <p className="mt-1 max-w-prose text-xs text-muted">{p.id === 'google_places' ? t('leadFinder.googleNotice') : t('leadFinder.osmNotice')}</p>
            </div>
            <div className="text-xs">
              <ul className="space-y-0.5">
                <LicenseItem ok={p.license.canStoreContent} label={t('leadFinder.licStore')} />
                <LicenseItem ok={p.license.canExport} label={t('leadFinder.licExport')} />
                <LicenseItem ok={p.license.canSaveToCrm} label={t('leadFinder.licCrm')} />
              </ul>
              <a href={p.license.termsUrl} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex items-center gap-1 text-flow hover:underline">
                {t('leadFinder.licTerms')} <ExternalLink className="size-3" aria-hidden />
              </a>
            </div>
          </li>
        ))}
        <li className="flex flex-wrap items-center gap-2 px-5 py-3.5">
          <Sparkles className="size-4 text-flow" aria-hidden />
          <span className="font-medium">{t('leadFinder.aiStatus')}</span>
          {data.ai.configured ? <Badge tone="ok">{t('leadFinder.aiReady')}</Badge> : <Badge tone="signal">{t('leadFinder.configRequired')}</Badge>}
          {!data.ai.configured && (
            <span className="text-xs text-muted">
              {isOrgAdmin && data.ai.missing.length ? t('leadFinder.configMissing', { vars: data.ai.missing.join(', ') }) : t('leadFinder.configAskAdmin')}
            </span>
          )}
        </li>
      </ul>
    </section>
  )
}

export function NoProviderNotice() {
  const { t } = useI18n()
  return (
    <div role="status" className="flex gap-3 rounded-[var(--radius-control)] border border-signal/40 bg-signal-soft p-3.5 text-sm">
      <PlugZap className="mt-0.5 size-4 shrink-0 text-signal" aria-hidden />
      <p>{t('leadFinder.noProvider')}</p>
    </div>
  )
}
