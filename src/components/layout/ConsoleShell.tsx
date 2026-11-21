import type { ReactNode } from 'react'
import { NavLink, Outlet, Link } from 'react-router-dom'
import { Activity, ArrowLeft, Bot, Building2, ChartLine, Gauge, History, LifeBuoy, Settings2, ShieldAlert, Store, TrendingUp } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { useI18n } from '../../i18n'
import { cn } from '../../lib/cn'
import { Logo } from '../ui/Logo'
import { LanguageSwitch, ThemeToggle } from '../ui/Preferences'
import { EmptyState, FullPageLoader } from '../ui/States'

const SA_NAV = [
  { to: '/super-admin', key: 'overview', icon: Gauge, end: true },
  { to: '/super-admin/organizations', key: 'organizations', icon: Building2 },
  { to: '/super-admin/usage', key: 'usage', icon: ChartLine },
  { to: '/super-admin/resellers', key: 'resellers', icon: Store },
  { to: '/super-admin/growth', key: 'growth', icon: TrendingUp },
  { to: '/super-admin/support', key: 'support', icon: LifeBuoy },
  { to: '/super-admin/system', key: 'system', icon: Activity },
  { to: '/super-admin/ai-monitoring', key: 'aiMonitoring', icon: Bot },
  { to: '/super-admin/settings', key: 'settings', icon: Settings2 },
  { to: '/super-admin/audit', key: 'audit', icon: History },
]

function Frame({ title, nav, children }: { title: string; nav?: { to: string; label: string; icon: typeof Gauge; end?: boolean }[]; children: ReactNode }) {
  const { t } = useI18n()
  return (
    <div className="min-h-dvh bg-bg">
      <header className="flex items-center justify-between gap-3 border-b border-line bg-surface px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <Logo compact />
          <span className="truncate font-semibold">{title}</span>
        </div>
        <div className="flex items-center gap-2">
          <Link to="/app" className="hidden items-center gap-1 rounded-md px-2 py-1 text-sm text-muted hover:bg-surface-2 hover:text-ink sm:inline-flex">
            <ArrowLeft className="size-4" aria-hidden />
            {t('console.backToApp')}
          </Link>
          <LanguageSwitch />
          <ThemeToggle />
        </div>
      </header>
      {nav && (
        <nav aria-label={title} className="flex gap-1 overflow-x-auto border-b border-line bg-surface px-3">
          {nav.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                cn('flex shrink-0 items-center gap-2 border-b-2 px-3 py-2.5 text-sm', isActive ? 'border-flow font-medium text-flow' : 'border-transparent text-muted hover:text-ink')
              }
            >
              <Icon className="size-4" aria-hidden />
              {label}
            </NavLink>
          ))}
        </nav>
      )}
      <main id="main" className="mx-auto max-w-7xl px-4 py-6">
        {children}
      </main>
    </div>
  )
}

/** Console Super Admin: il controllo reale è lato server (ogni API e RPC verifica il ruolo). */
export function SuperAdminShell() {
  const { status, isSuperAdmin } = useAuth()
  const { t } = useI18n()
  if (status === 'loading') return <FullPageLoader />
  return (
    <Frame title={t('console.superAdmin')} nav={isSuperAdmin ? SA_NAV.map((n) => ({ ...n, label: t(`saNav.${n.key}`) })) : undefined}>
      {isSuperAdmin ? <Outlet /> : <EmptyState icon={ShieldAlert} title={t('console.forbidden')} className="py-20" />}
    </Frame>
  )
}

export function ResellerShell() {
  const { t } = useI18n()
  return (
    <Frame title={t('console.reseller')} nav={[
      { to: '/reseller', label: t('resellerPortal.title'), icon: Store, end: true },
      { to: '/reseller/branding', label: t('resellerPortal.branding'), icon: Settings2 },
    ]}>
      <Outlet />
    </Frame>
  )
}
