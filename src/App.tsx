import { lazy, Suspense } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom'
import { PublicOnly, RequireAuth, RequireOrganization } from './routes/guards'
import { FullPageLoader, LoadingState } from './components/ui/States'
import { AppShell } from './components/layout/AppShell'
import { ResellerShell, SuperAdminShell } from './components/layout/ConsoleShell'
import Landing from './pages/Landing'
import { env } from './lib/env'

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
const DemandHunter = lazy(() => import('./pages/app/DemandHunter'))
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
const SuperAdminOverview = lazy(() => import('./pages/console/SuperAdminOverview'))
const SuperAdminOrganizations = lazy(() => import('./pages/console/SuperAdminOrganizations'))
const SuperAdminUsage = lazy(() => import('./pages/console/SuperAdminUsage'))
const SuperAdminResellers = lazy(() => import('./pages/console/SuperAdminResellers'))
const SuperAdminSettings = lazy(() => import('./pages/console/SuperAdminSettings'))
const SuperAdminAudit = lazy(() => import('./pages/console/SuperAdminAudit'))
const ResellerDashboard = lazy(() => import('./pages/console/ResellerDashboard'))
const ResellerBranding = lazy(() => import('./pages/console/ResellerBranding'))
const AcceptInvite = lazy(() => import('./pages/AcceptInvite'))
const JoinTeam = lazy(() => import('./pages/JoinTeam'))
const NotFound = lazy(() => import('./pages/NotFound'))
const Pricing = lazy(() => import('./pages/public/Pricing'))
const Demo = lazy(() => import('./pages/public/Demo'))
const DemoThanks = lazy(() => import('./pages/public/DemoThanks'))
const Legal = lazy(() => import('./pages/public/Legal'))
const Support = lazy(() => import('./pages/app/Support'))
const SuperAdminGrowth = lazy(() => import('./pages/console/SuperAdminGrowth'))
const SuperAdminSystem = lazy(() => import('./pages/console/SuperAdminSystem'))
const SuperAdminAiMonitoring = lazy(() => import('./pages/console/SuperAdminAiMonitoring'))
const SuperAdminAiTraining = lazy(() => import('./pages/console/SuperAdminAiTraining'))
const SuperAdminSupport = lazy(() => import('./pages/console/SuperAdminSupport'))
const AiAgents = lazy(() => import('./pages/app/AiAgents'))
const AiWorkflows = lazy(() => import('./pages/app/AiWorkflows'))

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
      {/* Sito pubblico (indicizzabile: home, prezzi, demo). Le pagine legali sono bozze: noindex. */}
      <Route path="/prezzi" element={<Pricing />} />
      <Route path="/pricing" element={<Navigate to="/prezzi" replace />} />
      <Route path="/demo" element={<Demo />} />
      <Route path="/demo/grazie" element={<DemoThanks />} />
      <Route path="/legal/:page" element={<Legal />} />
      <Route path="/privacy" element={<Navigate to="/legal/privacy" replace />} />
      <Route path="/contatti" element={<Navigate to="/legal/contatti" replace />} />

      <Route element={<PublicOnly />}>
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
      </Route>
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route path="/auth/callback" element={<AuthCallback />} />
      {/* Invito collaboratore: accessibile anche senza sessione (chiede login/registrazione). */}
      <Route path="/join" element={<JoinTeam />} />

      <Route element={<RequireAuth />}>
        <Route path="/onboarding" element={<Onboarding />} />
        <Route path="/invite" element={<Suspense fallback={<LoadingState />}><AcceptInvite /></Suspense>} />
        {/* Console Super Admin e portale rivenditori: non richiedono un'organizzazione. */}
        <Route path="/super-admin" element={<SuperAdminShell />}>
          <Route index element={<Suspense fallback={<LoadingState />}><SuperAdminOverview /></Suspense>} />
          <Route path="organizations" element={<Suspense fallback={<LoadingState />}><SuperAdminOrganizations /></Suspense>} />
          <Route path="usage" element={<Suspense fallback={<LoadingState />}><SuperAdminUsage /></Suspense>} />
          <Route path="resellers" element={<Suspense fallback={<LoadingState />}><SuperAdminResellers /></Suspense>} />
          <Route path="settings" element={<Suspense fallback={<LoadingState />}><SuperAdminSettings /></Suspense>} />
          <Route path="audit" element={<Suspense fallback={<LoadingState />}><SuperAdminAudit /></Suspense>} />
          <Route path="growth" element={<Suspense fallback={<LoadingState />}><SuperAdminGrowth /></Suspense>} />
          <Route path="support" element={<Suspense fallback={<LoadingState />}><SuperAdminSupport /></Suspense>} />
          <Route path="demo" element={<Navigate to="/super-admin/support" replace />} />
          <Route path="system" element={<Suspense fallback={<LoadingState />}><SuperAdminSystem /></Suspense>} />
          <Route path="ai-monitoring" element={<Suspense fallback={<LoadingState />}><SuperAdminAiMonitoring /></Suspense>} />
          <Route path="ai-training" element={<Suspense fallback={<LoadingState />}><SuperAdminAiTraining /></Suspense>} />
        </Route>
        <Route path="/reseller" element={<ResellerShell />}>
          <Route index element={<Suspense fallback={<LoadingState />}><ResellerDashboard /></Suspense>} />
          <Route path="branding" element={<Suspense fallback={<LoadingState />}><ResellerBranding /></Suspense>} />
        </Route>
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
            <Route path="demand-hunter" element={<Suspense fallback={<LoadingState />}><DemandHunter /></Suspense>} />
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
            {/* Prompt 8: motore multi-agent, solo con VITE_FEATURE_AI_AGENTS=true (beta privata; API protette lato server). */}
            {env.featureAiAgents && <Route path="ai-agents" element={<Suspense fallback={<LoadingState />}><AiAgents /></Suspense>} />}
            {env.featureAiAgents && <Route path="ai-workflows" element={<Suspense fallback={<LoadingState />}><AiWorkflows /></Suspense>} />}
            {PREVIEW_ROUTES.map(([path, key]) => (
              <Route key={path} path={path} element={<Suspense fallback={<LoadingState />}><ModulePreview moduleKey={key} /></Suspense>} />
            ))}
            <Route path="billing" element={<Suspense fallback={<LoadingState />}><Billing /></Suspense>} />
            <Route path="settings" element={<Suspense fallback={<LoadingState />}><Settings /></Suspense>} />
            <Route path="support" element={<Suspense fallback={<LoadingState />}><Support /></Suspense>} />
            {/* La console di piattaforma è ora su /super-admin (fuori dal contesto di un'organizzazione). */}
            <Route path="admin" element={<Navigate to="/super-admin" replace />} />
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
