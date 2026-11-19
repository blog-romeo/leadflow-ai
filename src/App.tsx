import { lazy, Suspense } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useParams } from 'react-router-dom'
import { PublicOnly, RequireAuth, RequireOrganization } from './routes/guards'
import { FullPageLoader, LoadingState } from './components/ui/States'
import { AppShell } from './components/layout/AppShell'
import Landing from './pages/Landing'

// Le pagine autenticate sono caricate on demand per ridurre il bundle della landing.
const Login = lazy(() => import('./pages/auth/Login'))
const Register = lazy(() => import('./pages/auth/Register'))
const ForgotPassword = lazy(() => import('./pages/auth/ForgotPassword'))
const ResetPassword = lazy(() => import('./pages/auth/ResetPassword'))
const AuthCallback = lazy(() => import('./pages/auth/AuthCallback'))
const Onboarding = lazy(() => import('./pages/Onboarding'))
const Dashboard = lazy(() => import('./pages/app/Dashboard'))
const Crm = lazy(() => import('./pages/app/Crm'))
const ModulePreview = lazy(() => import('./pages/app/ModulePreview'))
const LeadFinder = lazy(() => import('./pages/app/LeadFinder'))
const LeadScoring = lazy(() => import('./pages/app/LeadScoring'))
const Billing = lazy(() => import('./pages/app/Billing'))
const Settings = lazy(() => import('./pages/app/Settings'))
const SuperAdmin = lazy(() => import('./pages/app/SuperAdmin'))
const NotFound = lazy(() => import('./pages/NotFound'))

/** Moduli "in preparazione": path relativo sotto /app → chiave del registro moduli. */
const PREVIEW_ROUTES: [string, string][] = [
  ['business-analyzer', 'analyzer'],
  ['sales-agent', 'salesAgent'],
  ['campaigns', 'campaigns'],
  ['follow-up', 'followUp'],
  ['analytics', 'analytics'],
]

/** Alias /dashboard/* → /app/* (es. /dashboard/lead-finder). */
function DashboardAlias() {
  const params = useParams()
  return <Navigate to={`/app/${params['*'] ?? ''}`} replace />
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />

      <Route element={<PublicOnly />}>
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
      </Route>
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route path="/auth/callback" element={<AuthCallback />} />

      <Route element={<RequireAuth />}>
        <Route path="/onboarding" element={<Onboarding />} />
        <Route element={<RequireOrganization />}>
          <Route path="/app" element={<AppShell />}>
            <Route
              index
              element={
                <Suspense fallback={<LoadingState />}>
                  <Dashboard />
                </Suspense>
              }
            />
            <Route path="crm" element={<Suspense fallback={<LoadingState />}><Crm /></Suspense>} />
            <Route path="lead-finder" element={<Suspense fallback={<LoadingState />}><LeadFinder /></Suspense>} />
            <Route path="lead-scoring" element={<Suspense fallback={<LoadingState />}><LeadScoring /></Suspense>} />
            {PREVIEW_ROUTES.map(([path, key]) => (
              <Route key={path} path={path} element={<Suspense fallback={<LoadingState />}><ModulePreview moduleKey={key} /></Suspense>} />
            ))}
            <Route path="billing" element={<Suspense fallback={<LoadingState />}><Billing /></Suspense>} />
            <Route path="settings" element={<Suspense fallback={<LoadingState />}><Settings /></Suspense>} />
            <Route path="admin" element={<Suspense fallback={<LoadingState />}><SuperAdmin /></Suspense>} />
            <Route path="*" element={<Suspense fallback={<LoadingState />}><NotFound /></Suspense>} />
          </Route>
        </Route>
      </Route>

      <Route path="/dashboard/*" element={<DashboardAlias />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<FullPageLoader />}>
        <AppRoutes />
      </Suspense>
    </BrowserRouter>
  )
}
