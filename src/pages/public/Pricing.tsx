import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useI18n } from '../../i18n'
import { PublicLayout } from '../../components/public/PublicLayout'
import { PricingCards } from '../../components/public/PricingCards'
import { buttonClasses } from '../../components/ui/Button'
import { RESELLER_PLANS, formatEuro } from '../../config/plans'
import { useSeo } from '../../lib/seo'
import { onConsentChange, track } from '../../lib/analytics'

export default function Pricing() {
  const { t, locale } = useI18n()
  useSeo({ title: t('seo.pricingTitle'), description: t('seo.pricingDescription'), path: '/prezzi', locale })
  useEffect(() => {
    track('pricing_viewed', '/prezzi')
    return onConsentChange(() => track('pricing_viewed', '/prezzi'))
  }, [])
  const conditions = ['c1', 'c2', 'c3', 'c4', 'c5'] as const
  return (
    <PublicLayout>
      <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6 lg:py-16">
        <h1 className="text-4xl font-semibold">{t('pricing.title')}</h1>
        <p className="mt-3 mb-10 max-w-[60ch] text-lg text-muted">{t('pricing.subtitle')}</p>
        <PricingCards />

        <section className="mt-14 grid gap-10 lg:grid-cols-2">
          <div>
            <h2 className="text-2xl font-semibold">{t('pricing.conditionsTitle')}</h2>
            <ul className="mt-4 list-disc space-y-2 pl-5 text-muted">
              {conditions.map((c) => (
                <li key={c}>{t(`pricing.conditions.${c}`)}</li>
              ))}
            </ul>
            <Link to="/legal/condizioni-abbonamento" className="mt-4 inline-block text-sm font-medium text-flow hover:underline">
              {t('pricing.conditionsLink')} →
            </Link>
          </div>
          <div className="rounded-[var(--radius-panel)] border border-line bg-surface p-6">
            <h2 className="text-2xl font-semibold">{t('pricing.whiteLabelTitle')}</h2>
            <p className="mt-2 text-muted">{t('pricing.whiteLabelBody')}</p>
            <ul className="mt-5 grid gap-4 sm:grid-cols-2">
              {RESELLER_PLANS.map((p) => (
                <li key={p.code} className="rounded-[var(--radius-control)] border border-line p-4">
                  <h3 className="font-semibold">{p.name}</h3>
                  <p className="mt-2">
                    <span className="font-display text-2xl font-semibold tabular">{formatEuro(p.monthlyPriceCents, locale)}</span>
                    <span className="text-muted">{t('pricing.perMonth')}</span>
                  </p>
                  <p className="text-sm text-muted">{t('pricing.setup', { amount: formatEuro(p.setupFeeCents, locale) })} · {t('pricing.vatExcluded')}</p>
                  <ul className="mt-3 space-y-1 text-sm">
                    <li>{t('pricing.orgs', { n: p.maxOrganizations })}</li>
                    <li>{p.maxCustomDomains === 1 ? t('pricing.oneDomain') : t('pricing.domains', { n: p.maxCustomDomains })}</li>
                  </ul>
                </li>
              ))}
            </ul>
            <Link to="/demo" className={buttonClasses('secondary', 'md', 'mt-5')}>
              {t('pricing.whiteLabelCta')}
            </Link>
          </div>
        </section>
      </div>
    </PublicLayout>
  )
}
