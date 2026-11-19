import { Link } from 'react-router-dom'
import { EyeOff, FileSearch, Hand, Lock } from 'lucide-react'
import { useI18n } from '../i18n'
import { MODULES } from '../config/modules'
import { Logo } from '../components/ui/Logo'
import { LanguageSwitch, ThemeToggle } from '../components/ui/Preferences'
import { buttonClasses } from '../components/ui/Button'
import { FlowVisual } from '../components/FlowVisual'
import { Badge } from '../components/ui/Badge'

export default function Landing() {
  const { t } = useI18n()

  const compliance = [
    { Icon: FileSearch, title: 'landing.compliance1Title', body: 'landing.compliance1Body' },
    { Icon: Hand, title: 'landing.compliance2Title', body: 'landing.compliance2Body' },
    { Icon: Lock, title: 'landing.compliance3Title', body: 'landing.compliance3Body' },
    { Icon: EyeOff, title: 'landing.compliance4Title', body: 'landing.compliance4Body' },
  ]
  const steps = [
    { title: 'landing.start1Title', body: 'landing.start1Body' },
    { title: 'landing.start2Title', body: 'landing.start2Body' },
    { title: 'landing.start3Title', body: 'landing.start3Body' },
  ]
  const productModules = MODULES.filter((m) => m.access !== 'super_admin')

  return (
    <div className="min-h-dvh bg-bg">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2">
        {t('common.skipToContent')}
      </a>
      <header className="mx-auto flex h-16 max-w-6xl items-center gap-6 px-4 sm:px-6">
        <Link to="/" aria-label="LeadFlow AI">
          <Logo />
        </Link>
        <nav aria-label={t('common.appName')} className="hidden gap-6 text-sm text-muted md:flex">
          <a href="#prodotto" className="hover:text-ink">{t('landing.navProduct')}</a>
          <a href="#conformita" className="hover:text-ink">{t('landing.navCompliance')}</a>
          <a href="#inizio" className="hover:text-ink">{t('landing.navStart')}</a>
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <LanguageSwitch className="hidden sm:inline-flex" />
          <ThemeToggle />
          <Link to="/login" className={buttonClasses('ghost', 'sm', 'hidden sm:inline-flex')}>
            {t('common.signIn')}
          </Link>
          <Link to="/register" className={buttonClasses('primary', 'sm')}>
            {t('common.signUp')}
          </Link>
        </div>
      </header>

      <main id="main">
        {/* Hero: il percorso del lead è l'immagine guida */}
        <section className="mx-auto grid max-w-6xl items-center gap-10 px-4 pt-10 pb-16 sm:px-6 lg:grid-cols-[1fr_1.1fr] lg:pt-20 lg:pb-24">
          <div>
            <h1 className="max-w-[16ch] text-[2.5rem] leading-[1.05] font-semibold sm:text-6xl">{t('landing.heroTitle')}</h1>
            <p className="mt-6 max-w-[56ch] text-lg text-muted">{t('landing.heroBody')}</p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link to="/register" className={buttonClasses('primary', 'lg')}>
                {t('landing.heroCta')}
              </Link>
              <Link to="/login" className={buttonClasses('secondary', 'lg')}>
                {t('landing.heroSecondary')}
              </Link>
            </div>
          </div>
          <div className="rounded-[var(--radius-panel)] border border-line bg-surface p-4 sm:p-6">
            <FlowVisual />
          </div>
        </section>

        {/* Moduli con stato reale */}
        <section id="prodotto" className="border-t border-line bg-surface">
          <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
            <div className="max-w-2xl">
              <h2 className="text-3xl font-semibold">{t('landing.productTitle')}</h2>
              <p className="mt-3 text-muted">{t('landing.productBody')}</p>
            </div>
            <ul className="mt-10 grid gap-x-8 sm:grid-cols-2 lg:grid-cols-3">
              {productModules.map(({ key, labelKey, icon: Icon, status }) => (
                <li key={key} className="flex items-center gap-3 border-b border-line py-4">
                  <Icon className="size-5 shrink-0 text-flow" aria-hidden />
                  <span className="flex-1 font-medium">{t(labelKey)}</span>
                  {status === 'available' ? (
                    <Badge tone="ok">{t('common.available')}</Badge>
                  ) : (
                    <Badge tone="signal">{t('common.inPreparation')}</Badge>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* Conformità */}
        <section id="conformita" className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
          <h2 className="max-w-xl text-3xl font-semibold">{t('landing.complianceTitle')}</h2>
          <div className="mt-10 grid gap-8 sm:grid-cols-2">
            {compliance.map(({ Icon, title, body }) => (
              <div key={title} className="flex gap-4">
                <span className="grid size-10 shrink-0 place-items-center rounded-full bg-flow-soft text-flow">
                  <Icon className="size-5" aria-hidden />
                </span>
                <div>
                  <h3 className="text-lg font-semibold">{t(title)}</h3>
                  <p className="mt-1 max-w-[52ch] text-muted">{t(body)}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Come si inizia: è una vera sequenza, quindi numerata */}
        <section id="inizio" className="border-t border-line bg-surface">
          <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
            <h2 className="text-3xl font-semibold">{t('landing.startTitle')}</h2>
            <ol className="mt-10 grid gap-8 md:grid-cols-3">
              {steps.map((s, i) => (
                <li key={s.title} className="relative border-t-2 border-flow pt-5">
                  <span className="font-display text-sm font-semibold text-flow tabular">{i + 1}</span>
                  <h3 className="mt-1 text-lg font-semibold">{t(s.title)}</h3>
                  <p className="mt-1 text-muted">{t(s.body)}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-4 py-20 text-center sm:px-6">
          <h2 className="mx-auto max-w-[22ch] text-3xl font-semibold sm:text-4xl">{t('landing.finalTitle')}</h2>
          <Link to="/register" className={buttonClasses('primary', 'lg', 'mt-8')}>
            {t('landing.finalCta')}
          </Link>
        </section>
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 px-4 py-6 text-sm text-muted sm:flex-row sm:px-6">
          <Logo compact />
          <p>{t('landing.footerNote')}</p>
          <LanguageSwitch className="sm:hidden" />
        </div>
      </footer>
    </div>
  )
}
