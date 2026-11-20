import { lazy, Suspense } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom'
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
const SalesDashboard = lazy(() => import('./pages/app/SalesDashboard'))
const SalesProfile = lazy(() => import('./pages/app/SalesProfile'))
const SalesLead = lazy(() => import('./pages/app/SalesLead'))
const Pipeline = lazy(() => import('./pages/app/Pipeline'))
const FollowUps = lazy(() => import('./pages/app/FollowUps'))
const Campaigns = lazy(() => import('./pages/app/Campaigns'))
const CampaignDetail = lazy(() => import('./pages/app/CampaignDetail'))
const Inbox = lazy(() => import('./pages/app/Inbox'))
const CampaignAnalytics = lazy(() => import('./pages/app/CampaignAnalytics'))
const Automations = lazy(() => import('./pages/app/Automations'))
const Channels = lazy(() => import('./pages/app/Channels'))
const Billing = lazy(() => import('./pages/app/Billing'))
const Settings = lazy(() => import('./pages/app/Settings'))
const SuperAdmin = lazy(() => import('./pages/app/SuperAdmin'))
const NotFound = lazy(() => import('./pages/NotFound'))

/** Moduli "in preparazione": path relativo sotto /app → chiave del registro moduli. */
const PREVIEW_ROUTES: [string, string][] = [
  ['business-analyzer', 'analyzer'],
]

/** Alias /dashboard/* → /app/* (es. /dashboard/lead-finder). */
function DashboardAlias() {
  const params = useParams()
  const { search } = useLocation()
  return <Navigate to={`/app/${params['*'] ?? ''}${search}`} replace />
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
            <Route path="crm/pipeline" element={<Suspense fallback={<LoadingState />}><Pipeline /></Suspense>} />
            <Route path="sales-agent" element={<Suspense fallback={<LoadingState />}><SalesDashboard /></Suspense>} />
            <Route path="sales-agent/profile" element={<Suspense fallback={<LoadingState />}><SalesProfile /></Suspense>} />
            <Route path="sales-agent/leads/:leadId" element={<Suspense fallback={<LoadingState />}><SalesLead /></Suspense>} />
            <Route path="follow-up" element={<Suspense fallback={<LoadingState />}><FollowUps /></Suspense>} />
            <Route path="campaigns" element={<Suspense fallback={<LoadingState />}><Campaigns /></Suspense>} />
            <Route path="campaigns/:campaignId" element={<Suspense fallback={<LoadingState />}><CampaignDetail /></Suspense>} />
            <Route path="inbox" element={<Suspense fallback={<LoadingState />}><Inbox /></Suspense>} />
            <Route path="analytics" element={<Suspense fallback={<LoadingState />}><CampaignAnalytics /></Suspense>} />
            <Route path="automations" element={<Suspense fallback={<LoadingState />}><Automations /></Suspense>} />
            <Route path="settings/channels" element={<Suspense fallback={<LoadingState />}><Channels /></Suspense>} />
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
