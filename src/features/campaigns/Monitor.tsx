import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useI18n } from '../../i18n'
import { supabase } from '../../lib/supabase'
import type { AutomationJobRow, CampaignRow, CampaignStepRow, OutboundMessageRow } from '../../lib/database.types'
import { Panel } from '../../components/ui/Panel'
import { Badge } from '../../components/ui/Badge'
import { Kpi } from './shared'
import type { RecipientView } from './types'
import type { Metrics } from '../../pages/app/Campaigns'

const OUT_TONE: Record<string, 'neutral' | 'flow' | 'signal' | 'danger' | 'ok'> = {
  queued: 'neutral',
  sending: 'flow',
  sent: 'flow',
  delivered: 'ok',
  delivery_delayed: 'signal',
  bounced: 'danger',
  complained: 'danger',
  failed: 'danger',
  cancelled: 'neutral',
  unknown: 'signal',
}

/** Andamento di una campagna attivata: metriche, destinatari, messaggi, errori dei job. */
export function CampaignMonitor({ campaign, steps, recipients }: { campaign: CampaignRow; steps: CampaignStepRow[]; recipients: RecipientView[] }) {
  const { t, formatNumber, formatDate } = useI18n()
  const [m, setM] = useState<Metrics | null>(null)
  const [messages, setMessages] = useState<(OutboundMessageRow & { lead: { company_name: string } | null })[]>([])
  const [dead, setDead] = useState<AutomationJobRow[]>([])

  const load = useCallback(async () => {
    if (!supabase) return
    const from = new Date(campaign.created_at).toISOString()
    const to = new Date(Date.now() + 60_000).toISOString()
    const [mm, msgs, jobs] = await Promise.all([
      supabase.rpc('campaign_metrics', { p_org: campaign.organization_id, p_from: from, p_to: to, p_campaign: campaign.id }),
      supabase.from('outbound_messages').select('*, lead:leads(company_name)').eq('campaign_id', campaign.id).order('created_at', { ascending: false }).limit(50),
      supabase.from('automation_jobs').select('*').eq('campaign_id', campaign.id).eq('status', 'dead').order('updated_at', { ascending: false }).limit(20),
    ])
    setM((mm.data as unknown as Metrics) ?? null)
    setMessages((msgs.data ?? []) as unknown as (OutboundMessageRow & { lead: { company_name: string } | null })[])
    setDead((jobs.data ?? []) as AutomationJobRow[])
  }, [campaign.id, campaign.organization_id, campaign.created_at])

  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), 30_000)
    return () => clearInterval(timer)
  }, [load])

  const stepLabel = (pos: number | null) => {
    const s = steps.find((x) => x.position === pos)
    return s ? `${t('cm.content.day', { n: s.day_offset })} · ${t(`cm.content.stepKinds.${s.kind}`)}` : '—'
  }
  const reason = (c: string | null) => {
    if (!c) return ''
    const k = `cm.reasons.${c}`
    const v = t(k)
    return v === k ? c : v
  }
  const n = (v: number | undefined) => formatNumber(v ?? 0)

  return (
    <div className="space-y-5">
      {m && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <Kpi label={t('analytics.metrics.eligible')} value={n(m.totals.eligible)} />
          <Kpi label={t('analytics.metrics.sent')} value={n(m.totals.sent)} />
          <Kpi label={t('analytics.metrics.delivered')} value={n(m.totals.delivered)} />
          <Kpi label={t('analytics.metrics.bounced')} value={n(m.totals.bounced)} />
          <Kpi label={t('analytics.metrics.replies')} value={n(m.totals.replies)} />
          <Kpi label={t('analytics.metrics.appointments')} value={n(m.totals.appointments)} />
        </div>
      )}
      <Panel title={`${t('cm.monitor.recipients')} · ${formatNumber(recipients.length)}`}>
        <div className="-mx-5 overflow-x-auto">
          <table className="w-full min-w-[620px] text-sm">
            <caption className="sr-only">{t('cm.monitor.recipients')}</caption>
            <thead>
              <tr className="border-b border-line text-left text-xs text-muted">
                <th scope="col" className="px-5 py-2 font-medium">{t('cm.recipients.lead')}</th>
                <th scope="col" className="px-3 py-2 font-medium">{t('cm.monitor.status')}</th>
                <th scope="col" className="px-3 py-2 font-medium">{t('cm.monitor.step')}</th>
                <th scope="col" className="px-3 py-2 font-medium">{t('cm.monitor.next')}</th>
                <th scope="col" className="px-5 py-2 font-medium">{t('cm.monitor.reason')}</th>
              </tr>
            </thead>
            <tbody>
              {recipients.slice(0, 200).map((r) => (
                <tr key={r.id} className="border-b border-line/70 last:border-0">
                  <td className="px-5 py-2">
                    <Link to={`/app/sales-agent/leads/${r.lead_id}`} className="hover:underline">
                      {r.lead.company_name}
                    </Link>
                  </td>
                  <td className="px-3 py-2">
                    <Badge tone={r.status === 'in_sequence' ? 'flow' : r.status === 'completed' ? 'ok' : r.status === 'stopped' || r.status === 'excluded' ? 'danger' : 'neutral'}>{t(`cm.recipientStatus.${r.status}`)}</Badge>
                  </td>
                  <td className="px-3 py-2 text-muted">{r.current_position != null && r.current_position >= 0 ? stepLabel(r.current_position) : '—'}</td>
                  <td className="px-3 py-2 text-muted">{r.next_step_at ? formatDate(r.next_step_at) : '—'}</td>
                  <td className="px-5 py-2 text-muted">{reason(r.stopped_reason) || (r.status === 'excluded' ? reason(r.exclusion_reasons[0] ?? null) : '')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
      <Panel title={t('cm.monitor.messages')}>
        {messages.length === 0 ? (
          <p className="text-sm text-muted">—</p>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {messages.map((x) => (
              <li key={x.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div className="min-w-0">
                  <p className="font-medium break-words">{x.subject}</p>
                  <p className="text-xs text-muted">
                    {x.lead?.company_name ?? x.to_email} · {formatDate(x.sent_at ?? x.created_at)}
                    {x.last_error && x.status !== 'sent' && x.status !== 'delivered' ? ` · ${x.last_error}` : ''}
                  </p>
                </div>
                <Badge tone={OUT_TONE[x.status] ?? 'neutral'}>{t(`cm.monitor.outbound.${x.status}`)}</Badge>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <Panel title={t('cm.monitor.errors')}>
        {dead.length === 0 ? (
          <p className="text-sm text-muted">{t('cm.monitor.noErrors')}</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {dead.map((j) => (
              <li key={j.id} className="flex flex-wrap justify-between gap-2">
                <span className="font-mono text-xs">{j.kind}</span>
                <span className="text-danger">{j.last_error}</span>
                <span className="text-xs text-muted">{formatDate(j.updated_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  )
}
