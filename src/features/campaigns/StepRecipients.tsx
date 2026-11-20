import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { RefreshCw, Trash2 } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { useI18n } from '../../i18n'
import { supabase } from '../../lib/supabase'
import { PIPELINE_STAGES, type CampaignRow, type Json, type LeadSourceRow } from '../../lib/database.types'
import { Field } from '../../components/ui/Field'
import { Button } from '../../components/ui/Button'
import { Badge } from '../../components/ui/Badge'
import { InlineAlert } from '../../components/ui/States'
import { cmError, ReasonList, splitList } from './shared'
import type { RecipientView } from './types'

/** Passo 2: selezione dei destinatari dal CRM con filtri (eseguiti nel database). */
export function StepRecipients({ campaign, recipients, onChanged }: { campaign: CampaignRow; recipients: RecipientView[]; onChanged: () => void }) {
  const { t, formatNumber } = useI18n()
  const { isOrgAdmin } = useAuth()
  const editable = ['draft', 'pending_approval'].includes(campaign.status)
  const [sources, setSources] = useState<Pick<LeadSourceRow, 'id' | 'name'>[]>([])
  const saved = campaign.audience_filters as { industries?: string[]; countries?: string[]; cities?: string[]; tags?: string[]; min_score?: number; statuses?: string[]; source_ids?: string[] }
  const [f, setF] = useState({
    industries: (saved.industries ?? []).join(', '),
    countries: (saved.countries ?? []).join(', '),
    cities: (saved.cities ?? []).join(', '),
    tags: (saved.tags ?? []).join(', '),
    min_score: saved.min_score != null ? String(saved.min_score) : '',
    statuses: new Set<string>(saved.statuses ?? []),
    source_ids: new Set<string>(saved.source_ids ?? []),
  })
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    if (!supabase) return
    void supabase
      .from('lead_sources')
      .select('id, name')
      .eq('organization_id', campaign.organization_id)
      .order('name')
      .then(({ data }) => setSources((data ?? []) as Pick<LeadSourceRow, 'id' | 'name'>[]))
  }, [campaign.organization_id])

  async function add(e: FormEvent) {
    e.preventDefault()
    if (!supabase) return
    const filters: Record<string, unknown> = {}
    if (f.industries.trim()) filters.industries = splitList(f.industries)
    if (f.countries.trim()) filters.countries = splitList(f.countries).map((c) => c.toUpperCase())
    if (f.cities.trim()) filters.cities = splitList(f.cities)
    if (f.tags.trim()) filters.tags = splitList(f.tags)
    if (f.min_score.trim()) filters.min_score = Math.max(0, Math.min(100, Number(f.min_score) || 0))
    if (f.statuses.size) filters.statuses = [...f.statuses]
    if (f.source_ids.size) filters.source_ids = [...f.source_ids]
    setBusy(true)
    setMsg(null)
    const { data, error } = await supabase.rpc('add_campaign_recipients', { p_campaign: campaign.id, p_filters: filters as Json })
    setBusy(false)
    if (error) return setMsg({ ok: false, text: cmError(error, t) })
    const r = data as { added: number; total: number }
    setMsg({ ok: true, text: t('cm.recipients.added', { added: r.added, total: r.total }) })
    onChanged()
  }

  async function remove(id: string) {
    if (!supabase) return
    const { error } = await supabase.from('campaign_recipients').delete().eq('id', id)
    if (error) setMsg({ ok: false, text: cmError(error, t) })
    onChanged()
  }

  const toggle = (k: 'statuses' | 'source_ids', v: string) =>
    setF((x) => {
      const s = new Set(x[k])
      if (s.has(v)) s.delete(v)
      else s.add(v)
      return { ...x, [k]: s }
    })

  const sorted = useMemo(() => [...recipients].sort((a, b) => a.lead.company_name.localeCompare(b.lead.company_name)), [recipients])

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted">{t('cm.recipients.intro')}</p>
      {editable && (
        <form onSubmit={(e) => void add(e)} className="space-y-4 rounded-[var(--radius-panel)] border border-line p-4">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <Field label={t('cm.recipients.industries')} hint={t('cm.recipients.listHint')} value={f.industries} onChange={(e) => setF({ ...f, industries: e.target.value })} />
            <Field label={t('cm.recipients.countries')} hint={t('cm.recipients.listHint')} value={f.countries} onChange={(e) => setF({ ...f, countries: e.target.value })} />
            <Field label={t('cm.recipients.cities')} hint={t('cm.recipients.listHint')} value={f.cities} onChange={(e) => setF({ ...f, cities: e.target.value })} />
            <Field label={t('cm.recipients.tags')} hint={t('cm.recipients.listHint')} value={f.tags} onChange={(e) => setF({ ...f, tags: e.target.value })} />
            <Field label={t('cm.recipients.minScore')} type="number" min={0} max={100} inputMode="numeric" value={f.min_score} onChange={(e) => setF({ ...f, min_score: e.target.value })} />
          </div>
          <fieldset>
            <legend className="mb-2 text-sm font-medium">{t('cm.recipients.statuses')}</legend>
            <div className="flex flex-wrap gap-2">
              {PIPELINE_STAGES.map((s) => (
                <label key={s} className="inline-flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-xs has-[:checked]:border-flow has-[:checked]:bg-flow-soft">
                  <input type="checkbox" className="size-3.5" checked={f.statuses.has(s)} onChange={() => toggle('statuses', s)} />
                  {t(`status.${s}`)}
                </label>
              ))}
            </div>
          </fieldset>
          {sources.length > 0 && (
            <fieldset>
              <legend className="mb-2 text-sm font-medium">{t('cm.recipients.sources')}</legend>
              <div className="flex flex-wrap gap-2">
                {sources.map((s) => (
                  <label key={s.id} className="inline-flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-xs has-[:checked]:border-flow has-[:checked]:bg-flow-soft">
                    <input type="checkbox" className="size-3.5" checked={f.source_ids.has(s.id)} onChange={() => toggle('source_ids', s.id)} />
                    {s.name}
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" loading={busy}>
              {t('cm.recipients.add')}
            </Button>
            <span className="text-xs text-muted">{t('cm.recipients.max')}</span>
          </div>
        </form>
      )}
      <div aria-live="polite" className="empty:hidden">
        {msg && <InlineAlert tone={msg.ok ? 'ok' : 'danger'}>{msg.text}</InlineAlert>}
      </div>
      <section>
        <h3 className="mb-2 text-sm font-semibold">
          {t('cm.recipients.current')} · {formatNumber(recipients.length)}
        </h3>
        {sorted.length === 0 ? (
          <p className="text-sm text-muted">{t('cm.recipients.none')}</p>
        ) : (
          <ul className="divide-y divide-line rounded-[var(--radius-panel)] border border-line">
            {sorted.slice(0, 300).map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                <div className="min-w-0">
                  <Link to={`/app/sales-agent/leads/${r.lead_id}`} className="font-medium hover:underline">
                    {r.lead.company_name}
                  </Link>
                  <p className="text-xs text-muted">{[r.lead.industry, r.lead.city, r.lead.country].filter(Boolean).join(' · ')}</p>
                  {r.status === 'excluded' && <ReasonList codes={r.exclusion_reasons} className="mt-0.5 text-xs text-danger" />}
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone={r.status === 'eligible' || r.status === 'in_sequence' ? 'ok' : r.status === 'excluded' || r.status === 'stopped' ? 'danger' : 'neutral'}>{t(`cm.recipientStatus.${r.status}`)}</Badge>
                  {editable && isOrgAdmin && (
                    <Button size="sm" variant="ghost" onClick={() => void remove(r.id)} aria-label={`${t('cm.recipients.remove')} ${r.lead.company_name}`}>
                      <Trash2 className="size-4" aria-hidden />
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

/** Passo 3: esito dei controlli di idoneità per ogni destinatario. */
export function StepEligibility({ campaign, recipients, onChanged }: { campaign: CampaignRow; recipients: RecipientView[]; onChanged: () => void }) {
  const { t, formatNumber } = useI18n()
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const editable = ['draft', 'pending_approval'].includes(campaign.status)
  const counts = { eligible: 0, excluded: 0, pending: 0 }
  const byReason = new Map<string, number>()
  for (const r of recipients) {
    if (r.status === 'eligible' || r.status === 'in_sequence' || r.status === 'completed') counts.eligible++
    else if (r.status === 'excluded') counts.excluded++
    else if (r.status === 'pending') counts.pending++
    if (r.status === 'excluded') for (const c of r.exclusion_reasons) byReason.set(c, (byReason.get(c) ?? 0) + 1)
  }

  async function recheck() {
    if (!supabase) return
    setBusy(true)
    const { error } = await supabase.rpc('evaluate_campaign_recipients', { p_campaign: campaign.id })
    setBusy(false)
    setMsg(error ? cmError(error, t) : null)
    onChanged()
  }

  const txt = (ns: string, c: string) => {
    const k = `${ns}.${c}`
    const m = t(k)
    return m === k ? c : m
  }

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted">{t('cm.eligibility.intro')}</p>
      <div className="flex flex-wrap items-center gap-3">
        <Badge tone="ok">{t('cm.eligibility.eligible')}: {formatNumber(counts.eligible)}</Badge>
        <Badge tone="danger">{t('cm.eligibility.excluded')}: {formatNumber(counts.excluded)}</Badge>
        {counts.pending > 0 && <Badge tone="neutral">{t('cm.eligibility.pending')}: {formatNumber(counts.pending)}</Badge>}
        {editable && (
          <Button size="sm" variant="secondary" loading={busy} onClick={() => void recheck()}>
            <RefreshCw className="size-4" aria-hidden />
            {t('cm.eligibility.recheck')}
          </Button>
        )}
      </div>
      {msg && <InlineAlert>{msg}</InlineAlert>}
      {byReason.size > 0 && (
        <section>
          <h3 className="mb-2 text-sm font-semibold">{t('cm.eligibility.byReason')}</h3>
          <ul className="space-y-1 text-sm">
            {[...byReason.entries()]
              .sort((a, b) => b[1] - a[1])
              .map(([c, n]) => (
                <li key={c} className="flex justify-between gap-3 border-b border-line/60 pb-1">
                  <span>{txt('cm.reasons', c)}</span>
                  <span className="tabular font-medium">{formatNumber(n)}</span>
                </li>
              ))}
          </ul>
        </section>
      )}
      <p className="text-xs text-muted">{t('cm.eligibility.consentHint')}</p>
      <ul className="divide-y divide-line rounded-[var(--radius-panel)] border border-line">
        {recipients.slice(0, 300).map((r) => (
          <li key={r.id} className="space-y-1 px-3 py-2.5 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Link to={`/app/sales-agent/leads/${r.lead_id}`} className="font-medium hover:underline">
                {r.lead.company_name}
              </Link>
              <div className="flex flex-wrap gap-1.5">
                {r.eligibility.country && <Badge tone="neutral">{r.eligibility.country}</Badge>}
                {r.eligibility.basis && <Badge tone="flow">{txt('cm.eligibility.bases', r.eligibility.basis)}</Badge>}
                <Badge tone={r.status === 'excluded' ? 'danger' : r.status === 'pending' ? 'neutral' : 'ok'}>{t(`cm.recipientStatus.${r.status}`)}</Badge>
              </div>
            </div>
            {r.status === 'excluded' && <ReasonList codes={r.exclusion_reasons} className="text-xs text-danger" />}
            {!!r.eligibility.warnings?.length && <ReasonList codes={r.eligibility.warnings} ns="cm.warningsText" className="text-xs text-muted" />}
          </li>
        ))}
      </ul>
    </div>
  )
}
