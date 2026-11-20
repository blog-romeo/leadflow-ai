import { useCallback, useEffect, useState } from 'react'
import { Archive, Check, FileDown, FileText, Pencil, RotateCcw, Send, Sparkles } from 'lucide-react'
import { useI18n } from '../../i18n'
import { supabase } from '../../lib/supabase'
import type { MessageVariant, ProposalContent, SalesProfileRow, SalesProposalRow } from '../../lib/database.types'
import { Button } from '../../components/ui/Button'
import { Badge } from '../../components/ui/Badge'
import { Field, Select } from '../../components/ui/Field'
import { EmptyState, ErrorState, InlineAlert, LoadingState } from '../../components/ui/States'
import { cn } from '../../lib/cn'
import { salesErrorMessage } from './errors'
import { startGeneration, useJob } from './jobs'
import { JobBanner } from './JobBanner'
import { FactsList, WarningsList } from './WarningsList'

const VARIANTS: MessageVariant[] = ['professional', 'direct', 'consultative']
const statusTone = { draft: 'signal', approved: 'ok', sent_manually: 'flow', archived: 'neutral' } as const

export function useMoney(currency: string) {
  const { locale } = useI18n()
  const fmt = new Intl.NumberFormat(locale === 'it' ? 'it-IT' : 'en-GB', { style: 'currency', currency: currency || 'EUR', maximumFractionDigits: 2 })
  return (n: number) => fmt.format(n)
}

function PriceLine({ line, currency }: { line: NonNullable<ProposalContent['pricing']>['lines'][number]; currency: string }) {
  const { t } = useI18n()
  const money = useMoney(currency)
  const price =
    line.price_from != null && line.price_to != null
      ? `${money(line.price_from)} – ${money(line.price_to)}`
      : line.price_from != null
        ? t('sales.proposals.priceFrom', { price: money(line.price_from) })
        : line.price_to != null
          ? t('sales.proposals.priceUpTo', { price: money(line.price_to) })
          : t('sales.proposals.priceOnRequest')
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line py-2 last:border-0">
      <span className="font-medium">{line.name}</span>
      <span className="tabular text-sm">
        {price} {line.price_unit && <span className="text-muted">{line.price_unit}</span>}
      </span>
    </li>
  )
}

/** Anteprima leggibile della proposta (base per la futura esportazione PDF). */
function ProposalPreview({ p }: { p: SalesProposalRow }) {
  const { t } = useI18n()
  const c = p.content
  const S = ({ k, children }: { k: string; children: React.ReactNode }) => (
    <section className="mt-5">
      <h5 className="font-display text-base font-semibold">{t(`sales.proposals.sections.${k}`)}</h5>
      <div className="mt-1.5 text-sm leading-relaxed">{children}</div>
    </section>
  )
  return (
    <div className="rounded-[var(--radius-panel)] border border-line bg-surface p-5 sm:p-7">
      <h4 className="font-display text-xl font-semibold">{p.title}</h4>
      {c.company_presentation && <S k="company_presentation"><p className="whitespace-pre-wrap">{c.company_presentation}</p></S>}
      {c.opportunity?.statement && (
        <S k="opportunity">
          <p className="whitespace-pre-wrap">{c.opportunity.statement}</p>
          <Badge tone={c.opportunity.basis === 'verified' ? 'ok' : 'signal'} className="mt-1.5">
            {t(`sales.proposals.basis.${c.opportunity.basis}`)}
          </Badge>
        </S>
      )}
      {c.solution && <S k="solution"><p className="whitespace-pre-wrap">{c.solution}</p></S>}
      {!!c.services_included?.length && (
        <S k="services_included">
          <ul className="list-disc space-y-1 pl-5">{c.services_included.map((s, i) => <li key={i}>{s}</li>)}</ul>
        </S>
      )}
      {!!c.benefits?.length && (
        <S k="benefits">
          <ul className="list-disc space-y-1 pl-5">{c.benefits.map((s, i) => <li key={i}>{s}</li>)}</ul>
        </S>
      )}
      {!!c.pricing?.lines.length && (
        <S k="pricing">
          <ul>{c.pricing.lines.map((l) => <PriceLine key={l.service_id} line={l} currency={c.pricing!.currency} />)}</ul>
          {c.pricing.price_range && <p className="mt-1 text-xs text-muted">{c.pricing.price_range}</p>}
        </S>
      )}
      {c.conditions && <S k="conditions"><p className="whitespace-pre-wrap">{c.conditions}</p></S>}
      {c.call_to_action && <S k="call_to_action"><p className="font-medium">{c.call_to_action}</p></S>}
    </div>
  )
}

function ProposalEditor({ p, profile, onCancel, onSaved }: { p: SalesProposalRow; profile: SalesProfileRow | null; onCancel: () => void; onSaved: (msg: string, tone: 'ok' | 'danger') => void }) {
  const { t } = useI18n()
  const c = p.content
  const [title, setTitle] = useState(p.title)
  const [f, setF] = useState({
    company_presentation: c.company_presentation ?? '',
    opportunity: c.opportunity?.statement ?? '',
    solution: c.solution ?? '',
    services_included: (c.services_included ?? []).join('\n'),
    benefits: (c.benefits ?? []).join('\n'),
    conditions: c.conditions ?? profile?.commercial_terms ?? '',
    call_to_action: c.call_to_action ?? profile?.call_to_action ?? '',
  })
  const [selected, setSelected] = useState<Set<string>>(new Set((c.pricing?.lines ?? []).map((l) => l.service_id)))
  const [busy, setBusy] = useState(false)
  const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean)

  async function save() {
    if (!supabase) return
    setBusy(true)
    const services = (profile?.services ?? []).filter((s) => selected.has(s.id))
    const content: ProposalContent = {
      ...c,
      company_presentation: f.company_presentation,
      opportunity: { statement: f.opportunity, basis: c.opportunity?.basis ?? 'hypothesis', evidence: c.opportunity?.evidence ?? '' },
      solution: f.solution,
      services_included: lines(f.services_included),
      benefits: lines(f.benefits),
      // Prezzi sempre dal listino del profilo commerciale.
      pricing: {
        currency: profile?.currency ?? c.pricing?.currency ?? 'EUR',
        price_range: profile?.price_range ?? null,
        lines: services.map((s) => ({ service_id: s.id, name: s.name, price_from: s.price_from ?? null, price_to: s.price_to ?? null, price_unit: s.price_unit ?? null })),
      },
      conditions: f.conditions,
      call_to_action: f.call_to_action,
    }
    const { error } = await supabase.from('sales_proposals').update({ title: title.trim() || p.title, content }).eq('id', p.id)
    setBusy(false)
    onSaved(error ? salesErrorMessage(error, t) : t('sales.proposals.saved'), error ? 'danger' : 'ok')
  }

  const area = (k: keyof typeof f, rows = 4, hint?: string) => (
    <div className="space-y-1.5">
      <label htmlFor={`pe-${k}`} className="block text-sm font-medium">
        {t(`sales.proposals.sections.${k}`)}
      </label>
      <textarea id={`pe-${k}`} rows={rows} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} className="w-full rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-sm focus:border-flow focus:outline-none" />
      {hint && <p className="text-xs text-muted">{hint}</p>}
    </div>
  )

  return (
    <div className="space-y-4 rounded-[var(--radius-panel)] border border-flow/50 bg-surface p-4 sm:p-5">
      <Field label={t('sales.opportunity.name')} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
      {area('company_presentation')}
      {area('opportunity')}
      {area('solution', 6)}
      {area('services_included', 4, t('sales.proposals.listHint'))}
      {area('benefits', 4, t('sales.proposals.listHint'))}
      <fieldset>
        <legend className="mb-1.5 text-sm font-medium">{t('sales.proposals.sections.pricing')}</legend>
        <p className="mb-2 text-xs text-muted">{t('sales.profile.servicesHint')}</p>
        <div className="flex flex-wrap gap-2">
          {(profile?.services ?? []).map((s) => (
            <label key={s.id} className="flex items-center gap-2 rounded-[var(--radius-control)] border border-line px-3 py-1.5 text-sm">
              <input
                type="checkbox"
                checked={selected.has(s.id)}
                onChange={(e) => {
                  const n = new Set(selected)
                  if (e.target.checked) n.add(s.id)
                  else n.delete(s.id)
                  setSelected(n)
                }}
                className="size-4 accent-[var(--lf-flow)]"
              />
              {s.name}
            </label>
          ))}
        </div>
      </fieldset>
      {area('conditions', 3)}
      {area('call_to_action', 2)}
      <div className="flex gap-2">
        <Button loading={busy} onClick={() => void save()}>
          {t('sales.proposals.save')}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
      </div>
    </div>
  )
}

export function ProposalBuilder({ orgId, leadId, contactable, aiReady, profile }: { orgId: string; leadId: string; contactable: boolean; aiReady: boolean; profile: SalesProfileRow | null }) {
  const { t, formatDate } = useI18n()
  const [items, setItems] = useState<SalesProposalRow[] | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [variant, setVariant] = useState<MessageVariant>('consultative')
  const [instructions, setInstructions] = useState('')
  const [notice, setNotice] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null)
  const [jobId, setJobId] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)

  const load = useCallback(async () => {
    if (!supabase) return
    const { data, error } = await supabase.from('sales_proposals').select('*').eq('organization_id', orgId).eq('lead_id', leadId).order('created_at', { ascending: false }).limit(30)
    setLoadError(!!error)
    const rows = (data ?? []) as unknown as SalesProposalRow[]
    setItems(rows)
    setSelectedId((cur) => cur ?? rows[0]?.id ?? null)
  }, [orgId, leadId])

  useEffect(() => {
    void load()
  }, [load])

  const { job, running } = useJob(jobId, (j) => {
    const pid = j.output?.proposal_id as string | undefined
    if (pid) setSelectedId(pid)
    void load()
  })

  async function generate() {
    setNotice(null)
    setStarting(true)
    try {
      const r = await startGeneration(orgId, { task: 'proposal', lead_id: leadId, variant, instructions: instructions.trim() || undefined })
      setJobId(r.job_id)
    } catch (err) {
      setNotice({ tone: 'danger', text: salesErrorMessage(err, t) })
    } finally {
      setStarting(false)
    }
  }

  async function createBlank() {
    if (!supabase) return
    const content: ProposalContent = {
      company_presentation: profile?.offer_description ?? '',
      pricing: { currency: profile?.currency ?? 'EUR', price_range: profile?.price_range ?? null, lines: [] },
      conditions: profile?.commercial_terms ?? '',
      call_to_action: profile?.call_to_action ?? '',
    }
    const { data, error } = await supabase
      .from('sales_proposals')
      .insert({ organization_id: orgId, lead_id: leadId, title: t('sales.proposals.newManual'), variant, language: profile?.language ?? 'it', content })
      .select('id')
      .single()
    if (error) return setNotice({ tone: 'danger', text: salesErrorMessage(error, t) })
    setSelectedId(data.id as string)
    setEditing(true)
    void load()
  }

  async function setStatus(p: SalesProposalRow, status: SalesProposalRow['status'], ok: string) {
    if (!supabase) return
    const { error } = await supabase.from('sales_proposals').update({ status }).eq('id', p.id)
    setNotice(error ? { tone: 'danger', text: salesErrorMessage(error, t) } : { tone: 'ok', text: ok })
    void load()
  }

  const current = items?.find((p) => p.id === selectedId) ?? null

  return (
    <section aria-labelledby="prop-title" className="space-y-4">
      <h3 id="prop-title" className="text-base font-semibold">
        {t('sales.proposals.title')}
      </h3>
      {contactable ? (
        <div className="grid gap-3 rounded-[var(--radius-panel)] border border-line bg-surface p-4 sm:grid-cols-[12rem_1fr_auto] sm:items-end">
          <Select label={t('sales.proposals.style')} value={variant} onChange={(e) => setVariant(e.target.value as MessageVariant)}>
            {VARIANTS.map((v) => (
              <option key={v} value={v}>
                {t(`sales.messages.variants.${v}`)}
              </option>
            ))}
          </Select>
          <Field label={t('sales.messages.instructions')} placeholder={t('sales.messages.instructionsPh')} value={instructions} onChange={(e) => setInstructions(e.target.value)} maxLength={500} />
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void generate()} loading={starting || running} disabled={!aiReady}>
              <Sparkles className="size-4" aria-hidden />
              {t('sales.proposals.generate')}
            </Button>
            <Button variant="secondary" onClick={() => void createBlank()}>
              {t('sales.proposals.newManual')}
            </Button>
          </div>
          <div className="sm:col-span-3">
            <JobBanner job={job} />
          </div>
        </div>
      ) : (
        <InlineAlert tone="signal">{t('sales.lead.blockedNote')}</InlineAlert>
      )}
      {notice && <InlineAlert tone={notice.tone}>{notice.text}</InlineAlert>}

      {loadError ? (
        <ErrorState message={t('sales.errors.generic')} onRetry={() => void load()} />
      ) : !items ? (
        <LoadingState />
      ) : items.length === 0 ? (
        <EmptyState icon={FileText} title={t('sales.proposals.empty')} className="rounded-[var(--radius-panel)] border border-dashed border-line" />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[16rem_1fr]">
          <ul className="space-y-1.5" aria-label={t('sales.proposals.title')}>
            {items.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedId(p.id)
                    setEditing(false)
                  }}
                  aria-current={p.id === selectedId ? 'true' : undefined}
                  className={cn('w-full rounded-[var(--radius-control)] border px-3 py-2 text-left text-sm', p.id === selectedId ? 'border-flow bg-flow-soft' : 'border-line hover:bg-surface-2')}
                >
                  <span className="block truncate font-medium">{p.title}</span>
                  <span className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted">
                    <Badge tone={statusTone[p.status]}>{t(`sales.proposals.status.${p.status}`)}</Badge>
                    {formatDate(p.created_at)} · {t('sales.proposals.version', { version: p.version })}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {current && (
            <div className="min-w-0 space-y-3">
              <div className="flex flex-wrap gap-2">
                {current.status === 'draft' && !editing && (
                  <>
                    <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
                      <Pencil className="size-4" aria-hidden />
                      {t('sales.proposals.edit')}
                    </Button>
                    <Button size="sm" onClick={() => void setStatus(current, 'approved', t('sales.proposals.approved'))}>
                      <Check className="size-4" aria-hidden />
                      {t('sales.proposals.approve')}
                    </Button>
                  </>
                )}
                {current.status === 'approved' && (
                  <Button size="sm" title={t('sales.proposals.markSentHint')} onClick={() => void setStatus(current, 'sent_manually', t('sales.proposals.sent'))} disabled={!contactable}>
                    <Send className="size-4" aria-hidden />
                    {t('sales.proposals.markSent')}
                  </Button>
                )}
                {(current.status === 'approved' || current.status === 'archived') && (
                  <Button size="sm" variant="ghost" onClick={() => void setStatus(current, 'draft', t('sales.proposals.saved'))}>
                    <RotateCcw className="size-4" aria-hidden />
                    {t('sales.proposals.backToDraft')}
                  </Button>
                )}
                {current.status !== 'archived' && (
                  <Button size="sm" variant="ghost" onClick={() => void setStatus(current, 'archived', t('sales.messages.archived'))}>
                    <Archive className="size-4" aria-hidden />
                    {t('sales.proposals.archive')}
                  </Button>
                )}
                <Button size="sm" variant="ghost" disabled title={t('sales.proposals.pdfSoon')}>
                  <FileDown className="size-4" aria-hidden />
                  {t('sales.proposals.pdf')} · {t('common.inPreparation')}
                </Button>
              </div>
              {current.status === 'approved' && <p className="text-xs text-muted">{t('sales.noSendNote')}</p>}
              <WarningsList warnings={current.warnings} />
              <FactsList facts={current.facts_used} />
              {editing ? (
                <ProposalEditor
                  key={current.id}
                  p={current}
                  profile={profile}
                  onCancel={() => setEditing(false)}
                  onSaved={(text, tone) => {
                    setNotice({ tone, text })
                    if (tone === 'ok') setEditing(false)
                    void load()
                  }}
                />
              ) : (
                <ProposalPreview p={current} />
              )}
            </div>
          )}
        </div>
      )}
    </section>
  )
}
