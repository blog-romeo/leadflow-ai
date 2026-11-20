import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { ArrowLeft, Archive, Pause, Play, SearchX, XCircle } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { useI18n } from '../../i18n'
import { supabase } from '../../lib/supabase'
import type { CampaignRow, CampaignStepRow, SalesProfileRow } from '../../lib/database.types'
import { Panel } from '../../components/ui/Panel'
import { Button } from '../../components/ui/Button'
import { Dialog } from '../../components/ui/Dialog'
import { EmptyState, InlineAlert, LoadingState } from '../../components/ui/States'
import { cn } from '../../lib/cn'
import { useSalesStatus } from '../../features/sales/useSalesStatus'
import { CampaignStatusBadge, cmError, useAccounts } from '../../features/campaigns/shared'
import { StepInfo } from '../../features/campaigns/StepInfo'
import { StepEligibility, StepRecipients } from '../../features/campaigns/StepRecipients'
import { StepContent } from '../../features/campaigns/StepContent'
import { StepActivation, StepReview, useReadiness } from '../../features/campaigns/StepReview'
import { CampaignMonitor } from '../../features/campaigns/Monitor'
import type { RecipientView } from '../../features/campaigns/types'

const STEPS = ['info', 'recipients', 'eligibility', 'content', 'review', 'activation'] as const

export default function CampaignDetail() {
  const { campaignId = 'new' } = useParams()
  const isNew = campaignId === 'new'
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const { t } = useI18n()
  const { currentOrg, isOrgAdmin } = useAuth()
  const orgId = currentOrg?.id ?? ''
  const { status: salesStatus } = useSalesStatus(orgId)
  const { accounts } = useAccounts(orgId)
  const [campaign, setCampaign] = useState<CampaignRow | null | undefined>(isNew ? null : undefined)
  const [steps, setSteps] = useState<CampaignStepRow[]>([])
  const [recipients, setRecipients] = useState<RecipientView[]>([])
  const [profile, setProfile] = useState<SalesProfileRow | null>(null)
  const [version, setVersion] = useState(0)
  const [confirmCancel, setConfirmCancel] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const stepIdx = Math.min(6, Math.max(1, Number(params.get('step') ?? '1') || 1))

  const load = useCallback(async () => {
    if (!supabase || !orgId) return
    const p = await supabase.from('sales_profiles').select('*').eq('organization_id', orgId).maybeSingle()
    setProfile((p.data as unknown as SalesProfileRow) ?? null)
    if (isNew) return
    const [c, seq, rec] = await Promise.all([
      supabase.from('campaigns').select('*').eq('organization_id', orgId).eq('id', campaignId).maybeSingle(),
      supabase.from('campaign_sequences').select('id').eq('organization_id', orgId).eq('campaign_id', campaignId).maybeSingle(),
      supabase.from('campaign_recipients').select('*, lead:leads(company_name, industry, city, country, contact_name)').eq('organization_id', orgId).eq('campaign_id', campaignId).limit(2000),
    ])
    setCampaign((c.data as unknown as CampaignRow) ?? null)
    if (seq.data) {
      const st = await supabase.from('campaign_steps').select('*').eq('sequence_id', seq.data.id).order('position')
      setSteps((st.data ?? []) as unknown as CampaignStepRow[])
    }
    const one = <T,>(x: T | T[] | null): T | null => (Array.isArray(x) ? (x[0] ?? null) : x)
    setRecipients(((rec.data ?? []) as unknown as (RecipientView & { lead: RecipientView['lead'] | RecipientView['lead'][] })[]).map((r) => ({ ...r, lead: one(r.lead) ?? { company_name: '—', industry: null, city: null, country: null, contact_name: null } })))
    setVersion((v) => v + 1)
  }, [orgId, campaignId, isNew])

  useEffect(() => {
    void load()
  }, [load])

  const { readiness, reload: reloadReadiness } = useReadiness(isNew ? '' : campaignId, [version])
  const refresh = () => {
    void load()
    void reloadReadiness()
  }

  async function transition(action: 'pause' | 'resume' | 'cancel' | 'archive') {
    if (!supabase || !campaign) return
    const { error } = await supabase.rpc('campaign_transition', { p_campaign: campaign.id, p_action: action })
    setMsg(error ? { ok: false, text: cmError(error, t) } : null)
    setConfirmCancel(false)
    refresh()
  }

  if (campaign === undefined) return <LoadingState />
  if (!isNew && campaign === null)
    return (
      <EmptyState
        icon={SearchX}
        title={t('cm.notFound')}
        action={
          <Link to="/app/campaigns" className="text-sm text-flow hover:underline">
            {t('cm.back')}
          </Link>
        }
      />
    )

  const building = isNew || (campaign && ['draft', 'pending_approval'].includes(campaign.status))
  const account = campaign?.account_id ? (accounts?.find((a) => a.id === campaign.account_id) ?? null) : null
  const aiReady = !!salesStatus?.ai.configured && !!salesStatus?.profile.complete
  const go = (n: number) => setParams({ step: String(n) }, { replace: true })

  return (
    <>
      <Link to="/app/campaigns" className="mb-3 inline-flex items-center gap-1 text-sm text-muted hover:text-ink">
        <ArrowLeft className="size-4" aria-hidden />
        {t('cm.back')}
      </Link>
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold break-words sm:text-[1.75rem]">{campaign?.name ?? t('cm.new')}</h1>
          {campaign && (
            <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted">
              <CampaignStatusBadge status={campaign.status} />
              {t(`cm.channels.${campaign.channel}`)}
              {campaign.status === 'paused' && campaign.paused_reason && <span>· {t('cm.monitor.pausedReason', { reason: t(`cm.monitor.pausedReasons.${campaign.paused_reason}`) })}</span>}
            </p>
          )}
        </div>
        {campaign && !building && (
          <div className="flex flex-wrap gap-2">
            {(campaign.status === 'running' || campaign.status === 'scheduled') && (
              <Button variant="secondary" onClick={() => void transition('pause')}>
                <Pause className="size-4" aria-hidden />
                {t('cm.monitor.pause')}
              </Button>
            )}
            {campaign.status === 'paused' && isOrgAdmin && (
              <Button onClick={() => void transition('resume')}>
                <Play className="size-4" aria-hidden />
                {t('cm.monitor.resume')}
              </Button>
            )}
            {['running', 'scheduled', 'paused'].includes(campaign.status) && isOrgAdmin && (
              <Button variant="danger" onClick={() => setConfirmCancel(true)}>
                <XCircle className="size-4" aria-hidden />
                {t('cm.monitor.cancel')}
              </Button>
            )}
            {['completed', 'cancelled', 'failed'].includes(campaign.status) && !campaign.archived_at && (
              <Button variant="secondary" onClick={() => void transition('archive')}>
                <Archive className="size-4" aria-hidden />
                {t('cm.monitor.archive')}
              </Button>
            )}
          </div>
        )}
      </div>
      <div aria-live="polite" className="mb-4 empty:hidden">
        {msg && <InlineAlert tone={msg.ok ? 'ok' : 'danger'}>{msg.text}</InlineAlert>}
      </div>

      {building ? (
        <div className="grid gap-5 lg:grid-cols-[13rem_1fr]">
          <nav aria-label={t('cm.title')} className="min-w-0">
            <ol className="flex gap-1 overflow-x-auto lg:flex-col">
              {STEPS.map((s, i) => {
                const n = i + 1
                const disabled = isNew && n > 1
                return (
                  <li key={s} className="shrink-0">
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => go(n)}
                      aria-current={stepIdx === n ? 'step' : undefined}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-[var(--radius-control)] px-3 py-2 text-left text-sm whitespace-nowrap disabled:opacity-40',
                        stepIdx === n ? 'bg-flow-soft font-medium text-flow' : 'text-muted hover:bg-surface-2 hover:text-ink',
                      )}
                    >
                      <span className={cn('grid size-6 shrink-0 place-items-center rounded-full border text-xs tabular', stepIdx === n ? 'border-flow' : 'border-line')}>{n}</span>
                      {t(`cm.steps.${s}`)}
                    </button>
                  </li>
                )
              })}
            </ol>
          </nav>
          <Panel title={`${t(`cm.steps.${STEPS[stepIdx - 1]}`)} · ${t('cm.steps.stepOf', { n: stepIdx })}`}>
            {stepIdx === 1 && (
              <StepInfo
                key={campaign?.updated_at ?? 'new'}
                orgId={orgId}
                campaign={campaign ?? null}
                profile={profile}
                accounts={accounts ?? []}
                onSaved={(id) => {
                  if (isNew) navigate(`/app/campaigns/${id}?step=2`, { replace: true })
                  else {
                    refresh()
                    go(2)
                  }
                }}
              />
            )}
            {campaign && stepIdx === 2 && <StepRecipients campaign={campaign} recipients={recipients} onChanged={refresh} />}
            {campaign && stepIdx === 3 && <StepEligibility campaign={campaign} recipients={recipients} onChanged={refresh} />}
            {campaign && stepIdx === 4 && <StepContent campaign={campaign} steps={steps} recipients={recipients} profile={profile} aiReady={aiReady} onChanged={refresh} />}
            {campaign && stepIdx === 5 && <StepReview campaign={campaign} account={account} readiness={readiness} onChanged={refresh} />}
            {campaign && stepIdx === 6 && <StepActivation campaign={campaign} account={account} readiness={readiness} onActivated={refresh} />}
            {campaign && stepIdx < 6 && (
              <div className="mt-6 flex justify-end border-t border-line pt-4">
                <Button variant="secondary" onClick={() => go(stepIdx + 1)}>
                  {t(`cm.steps.${STEPS[stepIdx]}`)} →
                </Button>
              </div>
            )}
          </Panel>
        </div>
      ) : (
        campaign && <CampaignMonitor campaign={campaign} steps={steps} recipients={recipients} />
      )}

      <Dialog
        open={confirmCancel}
        onClose={() => setConfirmCancel(false)}
        title={t('cm.monitor.cancel')}
        closeLabel={t('common.close')}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfirmCancel(false)}>
              {t('common.cancel')}
            </Button>
            <Button variant="danger" onClick={() => void transition('cancel')}>
              {t('cm.monitor.cancel')}
            </Button>
          </div>
        }
      >
        <p className="text-sm">{t('cm.monitor.confirmCancel')}</p>
      </Dialog>
    </>
  )
}
