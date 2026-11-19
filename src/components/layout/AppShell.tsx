import { useEffect, useRef, useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { LogOut, Menu, X } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { useI18n } from '../../i18n'
import { NAV_GROUPS, visibleModules } from '../../config/modules'
import { cn } from '../../lib/cn'
import { Logo } from '../ui/Logo'
import { LanguageSwitch, ThemeToggle } from '../ui/Preferences'
import { InlineAlert } from '../ui/States'

function initials(name: string): string {
  return (
    name
      .split(/[\s@.]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase())
      .join('') || '?'
  )
}

function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const { isSuperAdmin } = useAuth()
  const { t } = useI18n()
  const modules = visibleModules(isSuperAdmin)
  return (
    <nav aria-label={t('common.appName')} className="flex-1 space-y-5 overflow-y-auto px-3 py-4">
      {NAV_GROUPS.map((group) => {
        const items = modules.filter((m) => m.group === group.id)
        if (items.length === 0) return null
        return (
          <div key={group.id}>
            <p className="px-3 pb-1.5 text-xs font-medium text-muted">{t(group.labelKey)}</p>
            <ul className="space-y-0.5">
              {items.map(({ key, path, labelKey, icon: Icon, status }) => (
                <li key={key}>
                  <NavLink
                    to={path}
                    end={path === '/app'}
                    onClick={onNavigate}
                    className={({ isActive }) =>
                      cn(
                        'group relative flex items-center gap-3 rounded-[var(--radius-control)] px-3 py-2 text-sm transition-colors',
                        isActive ? 'bg-flow-soft font-medium text-flow' : 'text-ink/80 hover:bg-surface-2 hover:text-ink',
                      )
                    }
                  >
                    {({ isActive }) => (
                      <>
                        {isActive && <span className="absolute top-2 bottom-2 left-0 w-0.5 rounded-full bg-flow" aria-hidden />}
                        <Icon className="size-[18px] shrink-0" aria-hidden />
                        <span className="flex-1 truncate">{t(labelKey)}</span>
                        {status === 'preparation' && (
                          <span className="size-1.5 rounded-full bg-signal" title={t('common.inPreparation')}>
                            <span className="sr-only">({t('common.inPreparation')})</span>
                          </span>
                        )}
                      </>
                    )}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        )
      })}
    </nav>
  )
}

function OrgSwitcher() {
  const { memberships, currentOrg, currentRole, setCurrentOrgId } = useAuth()
  const { t } = useI18n()
  if (!currentOrg) return null
  return (
    <div className="border-b border-line px-4 py-3">
      {memberships.length > 1 ? (
        <>
          <label htmlFor="org-switch" className="sr-only">
            {t('nav.switchOrg')}
          </label>
          <select
            id="org-switch"
            value={currentOrg.id}
            onChange={(e) => setCurrentOrgId(e.target.value)}
            className="w-full truncate rounded-md border border-line bg-surface px-2 py-1.5 text-sm font-semibold"
          >
            {memberships.map((m) => (
              <option key={m.organization.id} value={m.organization.id}>
                {m.organization.name}
              </option>
            ))}
          </select>
        </>
      ) : (
        <p className="truncate text-sm font-semibold">{currentOrg.name}</p>
      )}
      {currentRole && <p className="mt-0.5 text-xs text-muted">{t(`roles.${currentRole}`)}</p>}
    </div>
  )
}

function UserFooter() {
  const { profile, user, signOut, isSuperAdmin } = useAuth()
  const { t } = useI18n()
  const name = profile?.full_name || user?.email || ''
  return (
    <div className="flex items-center gap-3 border-t border-line px-4 py-3">
      <span className="grid size-8 shrink-0 place-items-center rounded-full bg-surface-2 text-xs font-semibold" aria-hidden>
        {initials(name)}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{name}</p>
        {isSuperAdmin && <p className="text-xs text-signal">{t('roles.super_admin')}</p>}
      </div>
      <button
        type="button"
        onClick={() => void signOut()}
        className="grid size-8 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-ink"
        aria-label={t('common.signOut')}
        title={t('common.signOut')}
      >
        <LogOut className="size-4" aria-hidden />
      </button>
    </div>
  )
}

export function AppShell() {
  const { t } = useI18n()
  const { contextError } = useAuth()
  const [open, setOpen] = useState(false)
  const location = useLocation()
  const closeRef = useRef<HTMLButtonElement>(null)
  const mainRef = useRef<HTMLElement>(null)

  // Chiude il drawer al cambio pagina e sposta il focus sul contenuto.
  useEffect(() => {
    setOpen(false)
    mainRef.current?.focus({ preventScroll: true })
  }, [location.pathname])

  useEffect(() => {
    if (!open) return
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
    }
  }, [open])

  return (
    <div className="min-h-dvh bg-bg">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2">
        {t('common.skipToContent')}
      </a>

      {/* Sidebar desktop */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-line bg-surface lg:flex">
        <div className="flex h-16 items-center px-5">
          <Logo />
        </div>
        <OrgSwitcher />
        <SidebarNav />
        <UserFooter />
      </aside>

      {/* Drawer mobile/tablet */}
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label={t('common.appName')}>
          <button type="button" className="absolute inset-0 bg-ink/40" aria-label={t('common.closeMenu')} onClick={() => setOpen(false)} tabIndex={-1} />
          <aside className="absolute inset-y-0 left-0 flex w-[min(18rem,85vw)] flex-col bg-surface shadow-xl">
            <div className="flex h-16 items-center justify-between px-5">
              <Logo />
              <button
                ref={closeRef}
                type="button"
                onClick={() => setOpen(false)}
                className="grid size-9 place-items-center rounded-md hover:bg-surface-2"
                aria-label={t('common.closeMenu')}
              >
                <X className="size-5" aria-hidden />
              </button>
            </div>
            <OrgSwitcher />
            <SidebarNav onNavigate={() => setOpen(false)} />
            <UserFooter />
          </aside>
        </div>
      )}

      <div className="lg:pl-64">
        <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-line bg-bg/85 px-4 backdrop-blur sm:px-6">
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="grid size-9 place-items-center rounded-md hover:bg-surface-2 lg:hidden"
            aria-label={t('common.openMenu')}
            aria-expanded={open}
          >
            <Menu className="size-5" aria-hidden />
          </button>
          <span className="lg:hidden">
            <Logo compact />
          </span>
          <div className="ml-auto flex items-center gap-2">
            <LanguageSwitch />
            <ThemeToggle />
          </div>
        </header>
        <main id="main" ref={mainRef} tabIndex={-1} className="mx-auto w-full max-w-6xl px-4 py-6 outline-none sm:px-6 lg:py-8">
          {contextError && (
            <div className="mb-4">
              <InlineAlert>{t(contextError)}</InlineAlert>
            </div>
          )}
          <Outlet />
        </main>
      </div>
    </div>
  )
}
