import { useCallback, useEffect, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { ArrowLeft, Bot, ExternalLink } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { useI18n } from '../../i18n'
import { supabase } from '../../lib/supabase'
import type { LeadStatus, SalesProfileRow } from '../../lib/database.types'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { EmptyState, InlineAlert, LoadingState } from '../../components/ui/States'
import { SearchX } from 'lucide-react'
import { cn } from '../../lib/cn'
import { useSalesStatus } from '../../features/sales/useSalesStatus'
import { StageSelect } from '../../features/sales/StageSelect'
import { AppointmentsCard, ComplianceCard, IntelligencePanel, OpportunityCard } from '../../features/sales/LeadPanels'
import { MessageGenerator } from '../../features/sales/MessageGenerator'
import { ProposalBuilder } from '../../features/sales/ProposalBuilder'
import { FollowUpList } from '../../features/sales/FollowUpList'
import { Timeline } from '../../features/sales/Timeline'
import { Copilot } from '../../features/sales/Copilot'
import { safeHref } from '../../features/lead-finder/format'

type LeadView = {
  id: string
  company_name: string
  website: string | null
  industry: string | null
  city: string | null
  country: string | null
  status: LeadStatus
  contact_status: 'active' | 'opted_out' | 'suppressed'
  score: number | null
  priority: 'high' | 'medium' | 'low' | null
  source: { name: string; legal_basis: string } | null
}

const TABS = ['overview', 'messages', 'proposals', 'followUps', 'timeline'] as const
type Tab = (typeof TABS)[number]

export default function SalesLead() {
  const { leadId = '' } = useParams()
  const [params, setParams] = useSearchParams()
  const { t } = useI18n()
  const { currentOrg } = useAuth()
  const orgId = currentOrg?.id ?? ''
  const { status } = useSalesStatus(orgId)
  const [lead, setLead] = useState<LeadView | null | undefined>(undefined)
  const [profile, setProfile] = useState<SalesProfileRow | null>(null)
  const [notice, setNotice] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [prefill, setPrefill] = useState<string | null>(null)
  const [copilot, setCopilot] = useState(false)
  const tab: Tab = (TABS as readonly string[]).includes(params.get('tab') ?? '') ? (params.get('tab') as Tab) : 'overview'

  const load = useCallback(async () => {
    if (!supabase || !orgId) return
    const [l, p] = await Promise.all([
      supabase
        .from('leads')
        .select('id, company_name, website, industry, city, country, status, contact_status, score, priority, source:lead_sources(name, legal_basis)')
        .eq('organization_id', orgId)
        .eq('id', leadId)
        .is('deleted_at', null)
        .maybeSingle(),
      supabase.from('sales_profiles').select('*').eq('organization_id', orgId).maybeSingle(),
    ])
    const raw = l.data as unknown as (Omit<LeadView, 'source'> & { source: LeadView['source'] | LeadView['source'][] }) | null
    setLead(raw ? { ...raw, source: Array.isArray(raw.source) ? (raw.source[0] ?? null) : raw.source } : null)
    setProfile((p.data as unknown as SalesProfileRow) ?? null)
  }, [orgId, leadId])

  useEffect(() => {
    void load()
  }, [load])

  if (lead === undefined) return <LoadingState />
  if (lead === null)
    return (
      <EmptyState
        icon={SearchX}
        title={t('sales.lead.notFound')}
        action={
          <Link to="/app/crm/pipeline" className="text-sm text-flow hover:underline">
            {t('sales.lead.back')}
          </Link>
        }
      />
    )

  const contactable = lead.contact_status === 'active' && lead.status !== 'not_contactable'
  const aiReady = !!status?.ai.configured
  const profileComplete = !!status?.profile.complete
  const href = safeHref(lead.website)
  const bump = () => setRefreshKey((k) => k + 1)

  return (
    <>
      <Link to="/app/crm/pipeline" className="mb-3 inline-flex items-center gap-1 text-sm text-muted hover:text-ink">
        <ArrowLeft className="size-4" aria-hidden />
        {t('sales.lead.back')}
      </Link>
      <div className="mb-5 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold break-words sm:text-[1.75rem]">{lead.company_name}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted">
            {[lead.industry, lead.city, lead.country].filter(Boolean).join(' · ')}
            {href && (
              <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex items-center gap-1 text-flow hover:underline">
                {new URL(href).hostname.replace(/^www\./, '')} <ExternalLink className="size-3.5" aria-hidden />
              </a>
            )}
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Badge tone={contactable ? 'ok' : 'danger'}>{contactable ? t('sales.lead.contactable') : t('sales.lead.notContactable')}</Badge>
            {lead.score !== null && <Badge tone="neutral">{t('sales.lead.score', { score: lead.score })}</Badge>}
            {lead.priority && <Badge tone={lead.priority === 'high' ? 'ok' : lead.priority === 'medium' ? 'signal' : 'neutral'}>{t(`leadFinder.priority.${lead.priority}`)}</Badge>}
          </div>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="sm:w-60">
            <StageSelect
              leadId={lead.id}
              name={lead.company_name}
              value={lead.status}
              contactable={contactable}
              onChanged={(s) => {
                setLead({ ...lead, status: s })
                setNotice({ tone: 'ok', text: t('sales.lead.moved', { stage: t(`status.${s}`) }) })
                bump()
              }}
              onError={(text) => setNotice({ tone: 'danger', text })}
            />
          </div>
          <Button variant="secondary" onClick={() => setCopilot(true)}>
            <Bot className="size-4" aria-hidden />
            {t('sales.openCopilot')}
          </Button>
        </div>
      </div>

      {status && !status.ai.configured && <div className="mb-4"><InlineAlert tone="signal">{t('sales.banners.aiMissing')}</InlineAlert></div>}
      {status && !status.profile.complete && (
        <div className="mb-4">
          <InlineAlert tone="signal">
            {t('sales.banners.profileIncomplete')}{' '}
            <Link to="/app/sales-agent/profile" className="underline">
              {t('sales.banners.profileCta')}
            </Link>
          </InlineAlert>
        </div>
      )}
      <div aria-live="polite" className="mb-4 empty:hidden">
        {notice && <InlineAlert tone={notice.tone}>{notice.text}</InlineAlert>}
      </div>

      <div role="tablist" aria-label={lead.company_name} className="mb-5 flex gap-1 overflow-x-auto border-b border-line">
        {TABS.map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            id={`tab-${k}`}
            aria-selected={tab === k}
            aria-controls={`panel-${k}`}
            onClick={() => setParams({ tab: k }, { replace: true })}
            className={cn('-mb-px shrink-0 border-b-2 px-3 py-2 text-sm whitespace-nowrap', tab === k ? 'border-flow font-medium text-flow' : 'border-transparent text-muted hover:text-ink')}
          >
            {t(`sales.lead.tabs.${k}`)}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'overview' && (
          <div className="grid gap-5 xl:grid-cols-[1.5fr_1fr]">
            <IntelligencePanel orgId={orgId} leadId={lead.id} aiReady={aiReady} profileComplete={profileComplete} onCreateOpportunity={(s) => setPrefill(s)} />
            <div className="space-y-5">
              <ComplianceCard source={lead.source} contactStatus={lead.contact_status} contactable={contactable} />
              <OpportunityCard orgId={orgId} leadId={lead.id} companyName={lead.company_name} profile={profile} prefill={prefill} onChanged={bump} />
              <AppointmentsCard orgId={orgId} leadId={lead.id} bookingUrl={profile?.booking_url ?? null} onChanged={() => void load()} />
            </div>
          </div>
        )}
        {tab === 'messages' && <MessageGenerator orgId={orgId} leadId={lead.id} contactable={contactable} aiReady={aiReady && profileComplete} />}
        {tab === 'proposals' && <ProposalBuilder orgId={orgId} leadId={lead.id} contactable={contactable} aiReady={aiReady && profileComplete} profile={profile} />}
        {tab === 'followUps' && <FollowUpList orgId={orgId} leadId={lead.id} aiReady={aiReady} contactable={contactable} refreshKey={refreshKey} />}
        {tab === 'timeline' && <Timeline orgId={orgId} leadId={lead.id} refreshKey={refreshKey} />}
      </div>

      {copilot && <Copilot orgId={orgId} open onClose={() => setCopilot(false)} leadId={lead.id} leadName={lead.company_name} />}
    </>
  )
}
