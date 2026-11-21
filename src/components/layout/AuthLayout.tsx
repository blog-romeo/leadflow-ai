import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useI18n } from '../../i18n'
import { Logo } from '../ui/Logo'
import { LanguageSwitch, ThemeToggle } from '../ui/Preferences'
import { ConfigNotice } from '../ui/ConfigNotice'
import { FlowVisual } from '../FlowVisual'
import { env } from '../../lib/env'
import { safeHttps, useTenant } from '../../contexts/TenantContext'

export function AuthLayout({ title, subtitle, children, footer }: { title: string; subtitle?: string; children: ReactNode; footer?: ReactNode }) {
  const { t } = useI18n()
  const tenant = useTenant()
  const privacy = safeHttps(tenant?.privacy_url)
  const terms = safeHttps(tenant?.terms_url)
  return (
    <div className="grid min-h-dvh bg-bg lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
      <div className="flex flex-col px-4 py-6 sm:px-10">
        <header className="flex items-center justify-between">
          <Link to="/" aria-label={tenant?.platform_name ?? 'LeadFlow AI'}>
            <Logo variant="login" />
          </Link>
          <div className="flex items-center gap-2">
            <LanguageSwitch />
            <ThemeToggle />
          </div>
        </header>
        <main id="main" className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center py-10">
          <h1 className="text-3xl font-semibold">{title}</h1>
          {subtitle && <p className="mt-2 text-muted">{subtitle}</p>}
          {!env.isSupabaseConfigured && (
            <div className="mt-6">
              <ConfigNotice />
            </div>
          )}
          <div className="mt-8">{children}</div>
          {footer && <div className="mt-8 text-sm text-muted">{footer}</div>}
          {(tenant?.support_email || privacy || terms) && (
            <nav aria-label={t('tenantFooter.support')} className="mt-8 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
              {tenant?.support_email && <a className="hover:text-ink" href={`mailto:${tenant.support_email}`}>{t('tenantFooter.support')}: {tenant.support_email}</a>}
              {privacy && <a className="hover:text-ink" href={privacy} target="_blank" rel="noopener noreferrer">{t('tenantFooter.privacy')}</a>}
              {terms && <a className="hover:text-ink" href={terms} target="_blank" rel="noopener noreferrer">{t('tenantFooter.terms')}</a>}
            </nav>
          )}
        </main>
      </div>
      <aside className="hidden items-center border-l border-line bg-surface px-12 lg:flex" aria-hidden>
        <div className="w-full">
          <p className="mb-6 max-w-sm font-display text-xl font-semibold">{tenant?.welcome_title ?? t('landing.heroTitle')}</p>
          {tenant?.welcome_text && <p className="mb-6 max-w-sm text-muted">{tenant.welcome_text}</p>}
          <FlowVisual />
        </div>
      </aside>
    </div>
  )
}
