import type { ReactNode } from 'react'
import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { FullPageLoader } from '../components/ui/States'

/** Richiede una sessione valida. Senza sessione → /login, preservando la destinazione. */
export function RequireAuth({ children }: { children?: ReactNode }) {
  const { status, session } = useAuth()
  const location = useLocation()
  if (status === 'loading') return <FullPageLoader />
  if (!session) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />
  return children ? <>{children}</> : <Outlet />
}

/** Richiede l'appartenenza ad almeno un'organizzazione. Altrimenti → onboarding. */
export function RequireOrganization({ children }: { children?: ReactNode }) {
  const { status, currentOrg, contextError } = useAuth()
  if (status === 'loading') return <FullPageLoader />
  if (!currentOrg && !contextError) return <Navigate to="/onboarding" replace />
  return children ? <>{children}</> : <Outlet />
}

/** Solo per i super_admin di piattaforma. Il controllo reale è nelle policy RLS. */
export function RequireSuperAdmin({ children, fallback }: { children: ReactNode; fallback: ReactNode }) {
  const { isSuperAdmin } = useAuth()
  return <>{isSuperAdmin ? children : fallback}</>
}

/** Pagine pubbliche di autenticazione: se già autenticato → app. */
export function PublicOnly({ children }: { children?: ReactNode }) {
  const { status, session } = useAuth()
  if (status === 'loading') return <FullPageLoader />
  if (session) return <Navigate to="/app" replace />
  return children ? <>{children}</> : <Outlet />
}
