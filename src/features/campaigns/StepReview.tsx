import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { CheckCircle2, ShieldAlert } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { useI18n } from '../../i18n'
import { supabase } from '../../lib/supabase'
import type { CampaignRow, CommunicationAccountRow, Json } from '../../lib/database.types'
import { Button } from '../../components/ui/Button'
import { Field } from '../../components/ui/Field'
import { InlineAlert, LoadingState } from '../../components/ui/States'
import { Check, cmError, Kpi, ReasonList } from './shared'

export interface Readiness {
  can_activate: boolean
  can_submit: boolean
  issues: string[]
  warnings: string[]
  eligible: number
  excluded: number
  pending: number
  emails_remaining_month: number
  estimated_messages: number
}

export function useReadiness(campaignId: string, deps: unknown[]) {
  const [r, setR] = useState<Readiness | null>(null)
  const load = useCallback(async () => {
    if (!supabase) return
    const { data } = await supabase.rpc('campaign_readiness', { p_campaign: campaignId })
    setR((data as unknown as Readiness) ?? null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId, ...deps])
  useEffect(() => {
    void load()
  }, [load])
  return { readiness: r, reload: load }
}

/** Passo 5: revisione completa prima della richiesta di approvazione. Nessun invio. */
export function StepReview({ campaign, account, readiness, onChanged }: { campaign: CampaignRow; account: CommunicationAccountRow | null; readiness: Readiness | null; onChanged: () => void }) {
  const { t, formatNumber } = useI18n()
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  if (!readiness) return <LoadingState />

  async function transition(action: 'submit' | 'back_to_draft') {
    if (!supabase) return
    setBusy(true)
    const { error } = await supabase.rpc('campaign_transition', { p_campaign: campaign.id, p_action: action })
    setBusy(false)
    setMsg(error ? { ok: false, text: cmError(error, t) } : { ok: true, text: action === 'submit' ? t('cm.review.submitted') : t('cm.info.saved') })
    onChanged()
  }

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted">{t('cm.review.intro')}</p>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label={t('cm.review.eligible')} value={formatNumber(readiness.eligible)} />
        <Kpi label={t('cm.review.excluded')} value={formatNumber(readiness.excluded)} />
        <Kpi label={t('cm.review.messages')} value={formatNumber(readiness.estimated_messages)} hint={t('cm.review.messagesHint')} />
        <Kpi
          label={t('cm.review.channel')}
          value={<span className="text-base">{campaign.channel === 'email' ? (account ? account.from_email : '—') : t(`cm.channels.${campaign.channel}`)}</span>}
          sub={account ? t(`channels.status.${account.status}`) : undefined}
        />
      </div>
      <section className="rounded-[var(--radius-panel)] border border-line p-4 text-sm">
        <h3 className="mb-1 font-semibold">{t('cm.review.costs')}</h3>
        <p className="text-muted">{t('cm.review.costsBody', { n: formatNumber(readiness.estimated_messages), remaining: formatNumber(Math.max(0, readiness.emails_remaining_month)) })}</p>
      </section>
      {readiness.issues.length > 0 && (
        <section className="rounded-[var(--radius-panel)] border border-danger/40 bg-danger-soft p-4 text-sm text-danger">
          <h3 className="mb-1 flex items-center gap-1.5 font-semibold">
            <ShieldAlert className="size-4" aria-hidden />
            {t('cm.review.issues')}
          </h3>
          <ReasonList codes={readiness.issues} ns="cm.review.issuesText" className="list-disc pl-5" />
          {readiness.issues.some((i) => ['no_provider', 'provider_not_connected', 'domain_not_verified'].includes(i)) && (
            <Link to="/app/settings/channels" className="mt-2 inline-block underline">
              {t('cm.noProviderCta')}
            </Link>
          )}
        </section>
      )}
      {readiness.warnings.length > 0 && (
        <section className="rounded-[var(--radius-panel)] border border-signal/40 bg-signal-soft p-4 text-sm">
          <h3 className="mb-1 font-semibold">{t('cm.review.compliance')}</h3>
          <ReasonList codes={readiness.warnings} ns="cm.review.warningsText" className="list-disc pl-5" />
        </section>
      )}
      {readiness.can_activate && campaign.status === 'pending_approval' && (
        <p className="flex items-center gap-1.5 text-sm font-medium text-ok">
          <CheckCircle2 className="size-4" aria-hidden />
          {t('cm.review.ready')}
        </p>
      )}
      <div aria-live="polite" className="empty:hidden">
        {msg && <InlineAlert tone={msg.ok ? 'ok' : 'danger'}>{msg.text}</InlineAlert>}
      </div>
      <div className="flex flex-wrap gap-2">
        {campaign.status === 'draft' && (
          <Button onClick={() => void transition('submit')} loading={busy} disabled={!readiness.can_submit}>
            {t('cm.review.submit')}
          </Button>
        )}
        {campaign.status === 'pending_approval' && (
          <Button variant="secondary" onClick={() => void transition('back_to_draft')} loading={busy}>
            {t('cm.review.backToDraft')}
          </Button>
        )}
      </div>
    </div>
  )
}

/** Passo 6: attivazione esplicita da parte di un amministratore. */
export function StepActivation({ campaign, account, readiness, onActivated }: { campaign: CampaignRow; account: CommunicationAccountRow | null; readiness: Readiness | null; onActivated: () => void }) {
  const { t, formatNumber, formatDate } = useI18n()
  const { isOrgAdmin } = useAuth()
  const [ack, setAck] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  if (!readiness) return <LoadingState />

  async function activate() {
    if (!supabase || !readiness) return
    setBusy(true)
    const { error } = await supabase.rpc('campaign_transition', {
      p_campaign: campaign.id,
      p_action: 'activate',
      p_confirmation: { confirm: true, compliance_acknowledged: ack, expected_recipients: readiness.eligible } as Json,
    })
    setBusy(false)
    if (error) return setMsg({ ok: false, text: cmError(error, t) })
    setMsg({ ok: true, text: t('cm.activation.activated') })
    onActivated()
  }

  const blocked = campaign.status !== 'pending_approval'
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">{t('cm.activation.intro')}</p>
      {!isOrgAdmin && <InlineAlert tone="signal">{t('cm.activation.adminOnly')}</InlineAlert>}
      {blocked && <InlineAlert tone="signal">{t('cm.activation.notPending')}</InlineAlert>}
      {!blocked && !readiness.can_activate && (
        <section className="rounded-[var(--radius-panel)] border border-danger/40 bg-danger-soft p-4 text-sm text-danger">
          <ReasonList codes={readiness.issues} ns="cm.review.issuesText" className="list-disc pl-5" />
        </section>
      )}
      {!blocked && readiness.can_activate && isOrgAdmin && (
        <div className="space-y-4 rounded-[var(--radius-panel)] border border-line p-4">
          <p className="text-sm">{t('cm.activation.summary', { n: formatNumber(readiness.eligible), account: account?.from_email ?? '—' })}</p>
          {campaign.planned_start_at && new Date(campaign.planned_start_at) > new Date() && <p className="text-sm text-muted">{t('cm.activation.scheduledAt', { date: formatDate(campaign.planned_start_at) })}</p>}
          {readiness.warnings.length > 0 && <ReasonList codes={readiness.warnings} ns="cm.review.warningsText" className="list-disc pl-5 text-sm text-signal" />}
          <Check id="cm-ack" label={t('cm.activation.acknowledge')} checked={ack} onChange={setAck} />
          <Field label={t('cm.activation.confirmName')} value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" placeholder={campaign.name} />
          <Button onClick={() => void activate()} loading={busy} disabled={!ack || name.trim() !== campaign.name.trim()}>
            {t('cm.activation.activate')}
          </Button>
        </div>
      )}
      <div aria-live="polite" className="empty:hidden">
        {msg && <InlineAlert tone={msg.ok ? 'ok' : 'danger'}>{msg.text}</InlineAlert>}
      </div>
    </div>
  )
}
