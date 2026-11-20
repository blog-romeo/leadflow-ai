import { useCallback, useEffect, useState } from 'react'
import { Archive, Check, Copy, Pencil, RotateCcw, Sparkles } from 'lucide-react'
import { useI18n } from '../../i18n'
import { supabase } from '../../lib/supabase'
import type { MessageChannel, MessageDraftRow, MessageVariant } from '../../lib/database.types'
import { Button } from '../../components/ui/Button'
import { Badge } from '../../components/ui/Badge'
import { Field, Select } from '../../components/ui/Field'
import { EmptyState, ErrorState, InlineAlert, LoadingState } from '../../components/ui/States'
import { MessageSquareText } from 'lucide-react'
import { cn } from '../../lib/cn'
import { salesErrorMessage } from './errors'
import { startGeneration, useJob } from './jobs'
import { JobBanner } from './JobBanner'
import { FactsList, WarningsList } from './WarningsList'

const CHANNELS: MessageChannel[] = ['email', 'linkedin', 'whatsapp', 'phone_script', 'follow_up']
const VARIANTS: MessageVariant[] = ['professional', 'direct', 'consultative']
const hasSubject = (c: MessageChannel) => c === 'email' || c === 'follow_up'

function DraftCard({ draft, onChanged, onNotice }: { draft: MessageDraftRow; onChanged: () => void; onNotice: (tone: 'ok' | 'danger', text: string) => void }) {
  const { t, formatDate } = useI18n()
  const [editing, setEditing] = useState(false)
  const [subject, setSubject] = useState(draft.subject ?? '')
  const [body, setBody] = useState(draft.body)
  const [busy, setBusy] = useState(false)

  async function update(patch: Partial<Pick<MessageDraftRow, 'subject' | 'body' | 'status'>>, okText: string) {
    if (!supabase) return
    setBusy(true)
    const { error } = await supabase.from('message_drafts').update(patch).eq('id', draft.id)
    setBusy(false)
    if (error) return onNotice('danger', salesErrorMessage(error, t))
    onNotice('ok', okText)
    setEditing(false)
    onChanged()
  }

  async function copy() {
    const text = (draft.subject ? `${t('sales.messages.subject')}: ${draft.subject}\n\n` : '') + draft.body
    try {
      await navigator.clipboard.writeText(text)
      onNotice('ok', t('sales.messages.copied'))
    } catch {
      onNotice('danger', t('sales.errors.generic'))
    }
  }

  const tone = draft.status === 'approved' ? 'ok' : draft.status === 'archived' ? 'neutral' : 'signal'
  return (
    <article className={cn('flex min-w-0 flex-col gap-3 rounded-[var(--radius-panel)] border bg-surface p-4', draft.status === 'approved' ? 'border-ok/40' : 'border-line')}>
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-semibold">{t(`sales.messages.variants.${draft.variant}`)}</h4>
        <span className="flex items-center gap-1.5">
          {draft.generated_by === 'manual' && <Badge tone="neutral">{t('sales.messages.manual')}</Badge>}
          <Badge tone={tone}>{t(`sales.messages.status.${draft.status}`)}</Badge>
        </span>
      </header>
      {editing ? (
        <div className="space-y-3">
          {hasSubject(draft.channel) && <Field label={t('sales.messages.subject')} value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={300} />}
          <div className="space-y-1.5">
            <label htmlFor={`body-${draft.id}`} className="block text-sm font-medium">
              {t('sales.messages.body')}
            </label>
            <textarea
              id={`body-${draft.id}`}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={10}
              maxLength={8000}
              className="w-full rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-sm focus:border-flow focus:ring-2 focus:ring-flow/25 focus:outline-none"
            />
          </div>
        </div>
      ) : (
        <div className="space-y-2 text-sm">
          {draft.subject && (
            <p>
              <span className="text-muted">{t('sales.messages.subject')}: </span>
              <span className="font-medium">{draft.subject}</span>
            </p>
          )}
          <p className="whitespace-pre-wrap break-words">{draft.body}</p>
        </div>
      )}
      <WarningsList warnings={draft.warnings} />
      <FactsList facts={draft.facts_used} />
      <p className="text-xs text-muted">{t('sales.messages.generation', { date: formatDate(draft.created_at) })}</p>
      <footer className="mt-auto flex flex-wrap gap-2">
        {editing ? (
          <>
            <Button size="sm" loading={busy} disabled={!body.trim()} onClick={() => void update({ subject: hasSubject(draft.channel) ? subject.trim() || null : null, body: body.trim() }, t('sales.messages.saved'))}>
              {t('sales.messages.saveDraft')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              {t('common.cancel')}
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" variant="secondary" onClick={() => void copy()}>
              <Copy className="size-4" aria-hidden />
              {t('sales.messages.copy')}
            </Button>
            {draft.status === 'draft' && (
              <>
                <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
                  <Pencil className="size-4" aria-hidden />
                  {t('sales.messages.edit')}
                </Button>
                <Button size="sm" loading={busy} onClick={() => void update({ status: 'approved' }, t('sales.messages.approved'))}>
                  <Check className="size-4" aria-hidden />
                  {t('sales.messages.approve')}
                </Button>
              </>
            )}
            {draft.status !== 'draft' && (
              <Button size="sm" variant="ghost" onClick={() => void update({ status: 'draft' }, t('sales.messages.saved'))}>
                <RotateCcw className="size-4" aria-hidden />
                {t('sales.messages.backToDraft')}
              </Button>
            )}
            {draft.status !== 'archived' && (
              <Button size="sm" variant="ghost" onClick={() => void update({ status: 'archived' }, t('sales.messages.archived'))}>
                <Archive className="size-4" aria-hidden />
                {t('sales.messages.archive')}
              </Button>
            )}
          </>
        )}
      </footer>
    </article>
  )
}

export function MessageGenerator({ orgId, leadId, contactable, aiReady }: { orgId: string; leadId: string; contactable: boolean; aiReady: boolean }) {
  const { t } = useI18n()
  const [channel, setChannel] = useState<MessageChannel>('email')
  const [instructions, setInstructions] = useState('')
  const [drafts, setDrafts] = useState<MessageDraftRow[] | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const [notice, setNotice] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null)
  const [jobId, setJobId] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [manual, setManual] = useState<{ variant: MessageVariant; subject: string; body: string } | null>(null)

  const load = useCallback(async () => {
    if (!supabase) return
    let q = supabase.from('message_drafts').select('*').eq('organization_id', orgId).eq('lead_id', leadId).eq('channel', channel).order('created_at', { ascending: false }).limit(30)
    if (!showArchived) q = q.neq('status', 'archived')
    const { data, error } = await q
    setLoadError(!!error)
    setDrafts((data ?? []) as unknown as MessageDraftRow[])
  }, [orgId, leadId, channel, showArchived])

  useEffect(() => {
    setDrafts(null)
    void load()
  }, [load])

  const { job, running } = useJob(jobId, () => void load())

  async function generate() {
    setNotice(null)
    setStarting(true)
    try {
      const r = await startGeneration(orgId, { task: 'messages', lead_id: leadId, channel, instructions: instructions.trim() || undefined })
      setJobId(r.job_id)
    } catch (err) {
      setNotice({ tone: 'danger', text: salesErrorMessage(err, t) })
    } finally {
      setStarting(false)
    }
  }

  async function saveManual() {
    if (!supabase || !manual || !manual.body.trim()) return
    const { error } = await supabase.from('message_drafts').insert({
      organization_id: orgId,
      lead_id: leadId,
      channel,
      variant: manual.variant,
      subject: hasSubject(channel) ? manual.subject.trim() || null : null,
      body: manual.body.trim(),
    })
    if (error) return setNotice({ tone: 'danger', text: salesErrorMessage(error, t) })
    setManual(null)
    setNotice({ tone: 'ok', text: t('sales.messages.saved') })
    void load()
  }

  // Raggruppa per generazione: le tre varianti affiancate.
  const groups = new Map<string, MessageDraftRow[]>()
  for (const d of drafts ?? []) groups.set(d.generation_id, [...(groups.get(d.generation_id) ?? []), d])

  return (
    <section aria-labelledby="msg-title" className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h3 id="msg-title" className="text-base font-semibold">
          {t('sales.messages.title')}
        </h3>
        <label className="flex items-center gap-2 text-sm text-muted">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} className="size-4 accent-[var(--lf-flow)]" />
          {t('sales.messages.showArchived')}
        </label>
      </div>
      <div role="tablist" aria-label={t('sales.messages.channel')} className="flex flex-wrap gap-1.5">
        {CHANNELS.map((c) => (
          <button
            key={c}
            type="button"
            role="tab"
            aria-selected={channel === c}
            onClick={() => setChannel(c)}
            className={cn('rounded-[var(--radius-control)] border px-3 py-1.5 text-sm', channel === c ? 'border-flow bg-flow-soft font-medium text-flow' : 'border-line hover:bg-surface-2')}
          >
            {t(`sales.messages.channels.${c}`)}
          </button>
        ))}
      </div>
      {channel !== 'email' && <p className="text-xs text-muted">{t('sales.messages.manualCopy')}</p>}

      {contactable ? (
        <div className="grid gap-3 rounded-[var(--radius-panel)] border border-line bg-surface p-4 sm:grid-cols-[1fr_auto] sm:items-end">
          <Field label={t('sales.messages.instructions')} placeholder={t('sales.messages.instructionsPh')} value={instructions} onChange={(e) => setInstructions(e.target.value)} maxLength={500} />
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void generate()} loading={starting || running} disabled={!aiReady}>
              <Sparkles className="size-4" aria-hidden />
              {groups.size ? t('sales.messages.regenerate') : t('sales.messages.generate')}
            </Button>
            <Button variant="secondary" onClick={() => setManual({ variant: 'professional', subject: '', body: '' })}>
              <Pencil className="size-4" aria-hidden />
              {t('sales.messages.newManual')}
            </Button>
          </div>
          <div className="sm:col-span-2">
            <JobBanner job={job} />
          </div>
        </div>
      ) : (
        <InlineAlert tone="signal">{t('sales.lead.blockedNote')}</InlineAlert>
      )}

      {notice && <InlineAlert tone={notice.tone}>{notice.text}</InlineAlert>}

      {manual && (
        <div className="space-y-3 rounded-[var(--radius-panel)] border border-flow/50 bg-surface p-4">
          <Select label={t('sales.proposals.style')} value={manual.variant} onChange={(e) => setManual({ ...manual, variant: e.target.value as MessageVariant })}>
            {VARIANTS.map((v) => (
              <option key={v} value={v}>
                {t(`sales.messages.variants.${v}`)}
              </option>
            ))}
          </Select>
          {hasSubject(channel) && <Field label={t('sales.messages.subject')} value={manual.subject} onChange={(e) => setManual({ ...manual, subject: e.target.value })} maxLength={300} />}
          <div className="space-y-1.5">
            <label htmlFor="manual-body" className="block text-sm font-medium">
              {t('sales.messages.body')}
            </label>
            <textarea id="manual-body" rows={8} maxLength={8000} value={manual.body} onChange={(e) => setManual({ ...manual, body: e.target.value })} className="w-full rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-sm focus:border-flow focus:outline-none" />
          </div>
          <div className="flex gap-2">
            <Button size="sm" disabled={!manual.body.trim()} onClick={() => void saveManual()}>
              {t('sales.messages.saveDraft')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setManual(null)}>
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      )}

      {loadError ? (
        <ErrorState message={t('sales.errors.generic')} onRetry={() => void load()} />
      ) : !drafts ? (
        <LoadingState />
      ) : groups.size === 0 ? (
        <EmptyState icon={MessageSquareText} title={t('sales.messages.empty')} className="rounded-[var(--radius-panel)] border border-dashed border-line" />
      ) : (
        <div className="space-y-5">
          {[...groups.entries()].map(([gid, items]) => (
            <div key={gid} className="grid gap-3 lg:grid-cols-3">
              {items
                .sort((a, b) => VARIANTS.indexOf(a.variant) - VARIANTS.indexOf(b.variant))
                .map((d) => (
                  <DraftCard key={d.id} draft={d} onChanged={() => void load()} onNotice={(tone, text) => setNotice({ tone, text })} />
                ))}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
