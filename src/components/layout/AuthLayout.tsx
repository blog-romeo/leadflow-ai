import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useI18n } from '../../i18n'
import { Logo } from '../ui/Logo'
import { LanguageSwitch, ThemeToggle } from '../ui/Preferences'
import { ConfigNotice } from '../ui/ConfigNotice'
import { FlowVisual } from '../FlowVisual'
import { env } from '../../lib/env'

export function AuthLayout({ title, subtitle, children, footer }: { title: string; subtitle?: string; children: ReactNode; footer?: ReactNode }) {
  const { t } = useI18n()
  return (
    <div className="grid min-h-dvh bg-bg lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
      <div className="flex flex-col px-4 py-6 sm:px-10">
        <header className="flex items-center justify-between">
          <Link to="/" aria-label="LeadFlow AI">
            <Logo />
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
        </main>
      </div>
      <aside className="hidden items-center border-l border-line bg-surface px-12 lg:flex" aria-hidden>
        <div className="w-full">
          <p className="mb-6 max-w-sm font-display text-xl font-semibold">{t('landing.heroTitle')}</p>
          <FlowVisual />
        </div>
      </aside>
    </div>
  )
}
