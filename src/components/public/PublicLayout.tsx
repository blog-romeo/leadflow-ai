import type { ReactNode } from 'react'
import { Link, NavLink } from 'react-router-dom'
import { useI18n } from '../../i18n'
import { Logo } from '../ui/Logo'
import { LanguageSwitch, ThemeToggle } from '../ui/Preferences'
import { buttonClasses } from '../ui/Button'
import { ConsentBanner } from './ConsentBanner'
import { resetConsent } from '../../lib/analytics'
import { useAuth } from '../../contexts/AuthContext'
import { cn } from '../../lib/cn'

export const LEGAL_PAGES = ['privacy', 'cookie', 'termini', 'condizioni-abbonamento', 'cancellazione', 'informazioni-societarie', 'trattamento-dati-b2b', 'contatti'] as const
export type LegalPage = (typeof LEGAL_PAGES)[number]
const LEGAL_LABEL: Record<LegalPage, string> = {
  privacy: 'site.footer.privacy',
  cookie: 'site.footer.cookies',
  termini: 'site.footer.terms',
  'condizioni-abbonamento': 'site.footer.subscription',
  cancellazione: 'site.footer.cancellation',
  'informazioni-societarie': 'site.footer.companyInfo',
  'trattamento-dati-b2b': 'site.footer.b2bData',
  contatti: 'site.footer.contact',
}
export const legalLabelKey = (p: LegalPage) => LEGAL_LABEL[p]

/** Layout condiviso delle pagine pubbliche: intestazione, navigazione, footer legale, consenso. */
export function PublicLayout({ children }: { children: ReactNode }) {
  const { t } = useI18n()
  const { session } = useAuth()
  const navCls = ({ isActive }: { isActive: boolean }) => cn('hover:text-ink', isActive && 'text-ink font-medium')
  return (
    <div className="flex min-h-dvh flex-col bg-bg">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2">
        {t('common.skipToContent')}
      </a>
      <header className="mx-auto flex h-16 w-full max-w-6xl items-center gap-6 px-4 sm:px-6">
        <Link to="/" aria-label="LeadFlow AI">
          <Logo />
        </Link>
        <nav aria-label={t('site.footer.product')} className="hidden gap-6 text-sm text-muted md:flex">
          <a href="/#funzionalita" className="hover:text-ink">{t('site.nav.features')}</a>
          <a href="/#come-funziona" className="hover:text-ink">{t('site.nav.how')}</a>
          <NavLink to="/prezzi" className={navCls}>{t('site.nav.pricing')}</NavLink>
          <a href="/#faq" className="hover:text-ink">{t('site.nav.faq')}</a>
          <NavLink to="/demo" className={navCls}>{t('site.nav.demo')}</NavLink>
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <LanguageSwitch className="hidden sm:inline-flex" />
          <ThemeToggle />
          {session ? (
            <Link to="/app" className={buttonClasses('primary', 'sm')}>
              {t('nav.dashboard')}
            </Link>
          ) : (
            <>
              <Link to="/login" className={buttonClasses('ghost', 'sm', 'hidden sm:inline-flex')}>
                {t('common.signIn')}
              </Link>
              <Link to="/register" className={buttonClasses('primary', 'sm')}>
                {t('landing2.ctaStart')}
              </Link>
            </>
          )}
        </div>
      </header>
      <main id="main" className="flex-1">
        {children}
      </main>
      <footer className="border-t border-line bg-surface">
        <div className="mx-auto grid max-w-6xl gap-8 px-4 py-10 text-sm sm:grid-cols-3 sm:px-6">
          <div className="space-y-3">
            <Logo compact />
            <p className="max-w-[36ch] text-muted">{t('landing2.disclaimer')}</p>
            <LanguageSwitch className="sm:hidden" />
          </div>
          <nav aria-label={t('site.footer.product')}>
            <h2 className="font-semibold">{t('site.footer.product')}</h2>
            <ul className="mt-3 space-y-2 text-muted">
              <li><a href="/#funzionalita" className="hover:text-ink">{t('site.nav.features')}</a></li>
              <li><Link to="/prezzi" className="hover:text-ink">{t('site.nav.pricing')}</Link></li>
              <li><Link to="/demo" className="hover:text-ink">{t('landing2.ctaDemo')}</Link></li>
              <li><Link to="/legal/contatti" className="hover:text-ink">{t('site.footer.contact')}</Link></li>
            </ul>
          </nav>
          <nav aria-label={t('site.footer.legal')}>
            <h2 className="font-semibold">{t('site.footer.legal')}</h2>
            <ul className="mt-3 space-y-2 text-muted">
              {LEGAL_PAGES.filter((p) => p !== 'contatti').map((p) => (
                <li key={p}>
                  <Link to={`/legal/${p}`} className="hover:text-ink">{t(LEGAL_LABEL[p])}</Link>
                </li>
              ))}
              <li>
                <button type="button" onClick={resetConsent} className="hover:text-ink">
                  {t('site.footer.cookieSettings')}
                </button>
              </li>
            </ul>
          </nav>
        </div>
        <p className="border-t border-line py-4 text-center text-xs text-muted">
          © {new Date().getFullYear()} LeadFlow AI · [DA COMPLETARE: ragione sociale e P.IVA] · {t('site.footer.rights')}
        </p>
      </footer>
      <ConsentBanner />
    </div>
  )
}
