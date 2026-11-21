import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import { BarChart3, Bot, Building, Gauge, Kanban, Megaphone, Radar, ScanSearch, ShieldCheck, Hand, CreditCard, FileSearch, ChevronDown } from 'lucide-react'
import { useI18n } from '../i18n'
import { buttonClasses } from '../components/ui/Button'
import { Badge } from '../components/ui/Badge'
import { FlowVisual } from '../components/FlowVisual'
import { PublicLayout } from '../components/public/PublicLayout'
import { PricingCards } from '../components/public/PricingCards'
import { PUBLIC_FEATURES, type FeatureStatus } from '../config/features'
import { PLANS } from '../config/plans'
import { useSeo, siteOrigin } from '../lib/seo'
import { track, onConsentChange } from '../lib/analytics'

const FEATURE_ICON = { leadFinder: Radar, analyzer: ScanSearch, scoring: Gauge, salesAgent: Bot, crm: Kanban, campaigns: Megaphone, analytics: BarChart3, whiteLabel: Building }
const STATUS_TONE: Record<FeatureStatus, 'ok' | 'flow' | 'signal'> = { operational: 'ok', beta: 'flow', preparation: 'signal' }
export const FAQ_KEYS = ['1', '2', '3', '4', '5', '6', '7'] as const

export default function Landing() {
  const { t, locale } = useI18n()
  useSeo({
    title: t('seo.homeTitle'),
    description: t('seo.homeDescription'),
    path: '/',
    locale,
    jsonLd: [
      {
        '@context': 'https://schema.org',
        '@type': 'SoftwareApplication',
        name: 'LeadFlow AI',
        applicationCategory: 'BusinessApplication',
        operatingSystem: 'Web',
        url: `${siteOrigin()}/`,
        description: t('seo.homeDescription'),
        offers: PLANS.map((p) => ({ '@type': 'Offer', name: p.name, price: (p.priceCents / 100).toFixed(2), priceCurrency: 'EUR', valueAddedTaxIncluded: false })),
      },
      {
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        mainEntity: FAQ_KEYS.map((k) => ({ '@type': 'Question', name: t(`faq.items.q${k}`), acceptedAnswer: { '@type': 'Answer', text: t(`faq.items.a${k}`) } })),
      },
    ],
  })
  useEffect(() => {
    track('landing_visit', '/')
    return onConsentChange(() => track('landing_visit', '/'))
  }, [])

  const steps = ['1', '2', '3', '4'] as const
  const trust = [
    { Icon: ShieldCheck, k: '1' },
    { Icon: Hand, k: '2' },
    { Icon: CreditCard, k: '3' },
    { Icon: FileSearch, k: '4' },
  ]

  return (
    <PublicLayout>
      <section className="mx-auto grid max-w-6xl items-center gap-10 px-4 pt-10 pb-16 sm:px-6 lg:grid-cols-[1fr_1.05fr] lg:pt-20 lg:pb-24">
        <div>
          <h1 className="max-w-[18ch] text-[2.4rem] leading-[1.06] font-semibold sm:text-[3.4rem]">{t('landing2.heroTitle')}</h1>
          <p className="mt-6 max-w-[58ch] text-lg text-muted">{t('landing2.heroSubtitle')}</p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link to="/register" className={buttonClasses('primary', 'lg')}>
              {t('landing2.ctaStart')}
            </Link>
            <Link to="/demo" className={buttonClasses('secondary', 'lg')}>
              {t('landing2.ctaDemo')}
            </Link>
          </div>
          <p className="mt-4 text-sm text-muted">{t('landing2.heroNote')}</p>
        </div>
        <div className="rounded-[var(--radius-panel)] border border-line bg-surface p-4 sm:p-6">
          <FlowVisual />
        </div>
      </section>

      <section id="come-funziona" className="scroll-mt-20 border-t border-line bg-surface">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
          <h2 className="text-3xl font-semibold">{t('landing2.howTitle')}</h2>
          <ol className="mt-10 grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
            {steps.map((s) => (
              <li key={s} className="border-t-2 border-flow pt-5">
                <span className="font-display text-sm font-semibold text-flow tabular">{s}</span>
                <h3 className="mt-1 text-lg font-semibold">{t(`landing2.howSteps.s${s}Title`)}</h3>
                <p className="mt-1 text-muted">{t(`landing2.howSteps.s${s}Body`)}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section id="funzionalita" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-16 sm:px-6">
        <div className="max-w-2xl">
          <h2 className="text-3xl font-semibold">{t('landing2.featuresTitle')}</h2>
          <p className="mt-3 text-muted">{t('landing2.featuresBody')}</p>
        </div>
        <ul className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {PUBLIC_FEATURES.map((f) => {
            const Icon = FEATURE_ICON[f.key]
            return (
              <li key={f.key} className="rounded-[var(--radius-panel)] border border-line bg-surface p-5">
                <div className="flex items-center justify-between gap-2">
                  <Icon className="size-5 text-flow" aria-hidden />
                  <Badge tone={STATUS_TONE[f.status]}>{t(`landing2.status.${f.status}`)}</Badge>
                </div>
                <h3 className="mt-4 font-semibold">{t(`landing2.features.${f.key}.title`)}</h3>
                <p className="mt-1 text-sm text-muted">{t(`landing2.features.${f.key}.body`)}</p>
              </li>
            )
          })}
        </ul>
      </section>

      <section className="border-t border-line bg-surface">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
          <h2 className="max-w-xl text-3xl font-semibold">{t('landing2.trustTitle')}</h2>
          <div className="mt-10 grid gap-8 sm:grid-cols-2">
            {trust.map(({ Icon, k }) => (
              <div key={k} className="flex gap-4">
                <span className="grid size-10 shrink-0 place-items-center rounded-full bg-flow-soft text-flow">
                  <Icon className="size-5" aria-hidden />
                </span>
                <div>
                  <h3 className="text-lg font-semibold">{t(`landing2.trust.t${k}Title`)}</h3>
                  <p className="mt-1 max-w-[52ch] text-muted">{t(`landing2.trust.t${k}Body`)}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="prezzi" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-16 sm:px-6">
        <h2 className="text-3xl font-semibold">{t('landing2.pricingTitle')}</h2>
        <p className="mt-3 mb-8 text-muted">{t('landing2.pricingBody')}</p>
        <PricingCards />
        <Link to="/prezzi" className="mt-4 inline-block text-sm font-medium text-flow hover:underline">
          {t('pricing.conditionsTitle')} →
        </Link>
      </section>

      <section id="faq" className="scroll-mt-20 border-t border-line bg-surface">
        <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
          <h2 className="text-3xl font-semibold">{t('faq.title')}</h2>
          <div className="mt-8 divide-y divide-line border-y border-line">
            {FAQ_KEYS.map((k) => (
              <details key={k} className="group py-4">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-medium">
                  {t(`faq.items.q${k}`)}
                  <ChevronDown className="size-4 shrink-0 text-muted transition-transform group-open:rotate-180" aria-hidden />
                </summary>
                <p className="mt-3 text-muted">{t(`faq.items.a${k}`)}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-20 text-center sm:px-6">
        <h2 className="mx-auto max-w-[24ch] text-3xl font-semibold sm:text-4xl">{t('landing2.finalTitle')}</h2>
        <p className="mx-auto mt-3 max-w-[56ch] text-muted">{t('landing2.finalBody')}</p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Link to="/register" className={buttonClasses('primary', 'lg')}>
            {t('landing2.ctaStart')}
          </Link>
          <Link to="/demo" className={buttonClasses('secondary', 'lg')}>
            {t('landing2.ctaDemo')}
          </Link>
        </div>
      </section>
    </PublicLayout>
  )
}
