import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Sparkles } from 'lucide-react'
import { useI18n } from '../../i18n'
import { supabase } from '../../lib/supabase'
import { apiFetch } from '../../lib/api'
import type { CampaignRow, CampaignStepRow, SalesProfileRow } from '../../lib/database.types'
import { Field } from '../../components/ui/Field'
import { Button } from '../../components/ui/Button'
import { Badge } from '../../components/ui/Badge'
import { InlineAlert } from '../../components/ui/States'
import { WarningsList } from '../sales/WarningsList'
import { JobBanner } from '../sales/JobBanner'
import { useJob } from '../sales/jobs'
import { salesErrorMessage } from '../sales/errors'
import { cmError, TextArea } from './shared'
import type { RecipientView } from './types'

const render = (text: string, lead: RecipientView['lead'] | null) =>
  text
    .replace(/\{\{\s*(azienda|company_name)\s*\}\}/g, lead?.company_name ?? '{{azienda}}')
    .replace(/\{\{\s*(citta|city)\s*\}\}/g, lead?.city ?? '')
    .replace(/\{\{\s*(settore|industry)\s*\}\}/g, lead?.industry ?? '')
    .replace(/\{\{\s*(nome|first_name)\s*\}\}/g, lead?.contact_name?.split(' ')[0] ?? '')

/** Editor di uno step email: varianti AI, modifica manuale, anteprima con dati reali. */
function EmailStepEditor({ campaign, step, preview, aiReady, onSaved }: { campaign: CampaignRow; step: CampaignStepRow; preview: RecipientView | null; aiReady: boolean; onSaved: () => void }) {
  const { t } = useI18n()
  const editable = ['draft', 'pending_approval'].includes(campaign.status)
  const [subject, setSubject] = useState(step.subject ?? '')
  const [body, setBody] = useState(step.body ?? '')
  const [instructions, setInstructions] = useState('')
  const [jobId, setJobId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const { job, running } = useJob(jobId, () => onSaved())

  useEffect(() => {
    setSubject(step.subject ?? '')
    setBody(step.body ?? '')
  }, [step.subject, step.body])

  async function generate() {
    setMsg(null)
    try {
      const r = await apiFetch<{ job_id: string }>('/api/campaigns/generate-content', {
        method: 'POST',
        body: { organization_id: campaign.organization_id, campaign_id: campaign.id, position: step.position, ...(instructions.trim() ? { instructions: instructions.trim() } : {}) },
      })
      setJobId(r.job_id)
    } catch (err) {
      setMsg({ ok: false, text: salesErrorMessage(err, t) })
    }
  }

  async function save() {
    if (!supabase) return
    setBusy(true)
    const { error } = await supabase.from('campaign_steps').update({ subject: subject.trim() || null, body: body.trim() || null }).eq('id', step.id)
    setBusy(false)
    setMsg(error ? { ok: false, text: cmError(error, t) } : { ok: true, text: t('cm.content.saved') })
    if (!error) onSaved()
  }

  const dirty = subject !== (step.subject ?? '') || body !== (step.body ?? '')
  return (
    <div className="space-y-4">
      {editable && (
        <div className="space-y-3 rounded-[var(--radius-panel)] border border-dashed border-line p-4">
          {aiReady ? (
            <>
              <Field label={t('cm.content.instructions')} value={instructions} onChange={(e) => setInstructions(e.target.value)} maxLength={500} />
              <Button variant="secondary" onClick={() => void generate()} loading={running} disabled={running}>
                <Sparkles className="size-4" aria-hidden />
                {step.ai_variants.length ? t('cm.content.regenerate') : t('cm.content.generate')}
              </Button>
              <JobBanner job={job} />
            </>
          ) : (
            <p className="text-sm text-muted">{t('cm.content.aiUnavailable')}</p>
          )}
        </div>
      )}
      {step.ai_variants.length > 0 && editable && (
        <section aria-label={t('cm.content.variants')} className="grid gap-3 lg:grid-cols-3">
          {step.ai_variants.map((v) => (
            <article key={v.variant} className="flex min-w-0 flex-col gap-2 rounded-[var(--radius-panel)] border border-line p-3 text-sm">
              <Badge tone="flow" className="self-start">{t(`cm.content.variantNames.${v.variant}`)}</Badge>
              <p className="font-medium break-words">{v.subject}</p>
              <p className="whitespace-pre-wrap break-words text-ink/85">{v.body}</p>
              {v.call_to_action && <p className="text-xs text-muted">CTA: {v.call_to_action}</p>}
              {!!v.warnings?.length && <CampaignWarnings warnings={v.warnings} />}
              <Button
                size="sm"
                variant="secondary"
                className="mt-auto self-start"
                onClick={() => {
                  setSubject(v.subject)
                  setBody(v.call_to_action && !v.body.includes(v.call_to_action) ? `${v.body}\n\n${v.call_to_action}` : v.body)
                }}
              >
                {t('cm.content.useVariant')}
              </Button>
            </article>
          ))}
        </section>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-3">
          <Field label={t('cm.content.subject')} value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} disabled={!editable} />
          <TextArea id={`body-${step.id}`} label={t('cm.content.body')} value={body} onChange={setBody} rows={10} disabled={!editable} />
          {editable && (
            <Button onClick={() => void save()} loading={busy} disabled={!dirty}>
              {t('cm.content.save')}
            </Button>
          )}
          <div aria-live="polite" className="empty:hidden">
            {msg && <InlineAlert tone={msg.ok ? 'ok' : 'danger'}>{msg.text}</InlineAlert>}
          </div>
        </div>
        <section aria-label={t('cm.content.preview')} className="min-w-0 rounded-[var(--radius-panel)] border border-line bg-surface-2/50 p-4 text-sm">
          <p className="mb-2 text-xs text-muted">{preview ? t('cm.content.previewFor', { name: preview.lead.company_name }) : t('cm.content.previewNone')}</p>
          <p className="font-semibold break-words">{render(subject, preview?.lead ?? null)}</p>
          <p className="mt-2 whitespace-pre-wrap break-words">{render(body, preview?.lead ?? null)}</p>
        </section>
      </div>
    </div>
  )
}

function CampaignWarnings({ warnings }: { warnings: { code: string; detail?: string }[] }) {
  const { t } = useI18n()
  // Avvisi specifici delle campagne + quelli comuni del Sales Agent.
  const own = warnings.filter((w) => t(`cm.warnings.${w.code}`) !== `cm.warnings.${w.code}`)
  const rest = warnings.filter((w) => !own.includes(w))
  return (
    <div className="space-y-1">
      {own.length > 0 && (
        <ul className="list-disc rounded-[var(--radius-control)] border border-danger/40 bg-danger-soft px-6 py-1.5 text-xs text-danger">
          {own.map((w, i) => (
            <li key={i}>{t(`cm.warnings.${w.code}`, { detail: w.detail ?? '' })}</li>
          ))}
        </ul>
      )}
      {rest.length > 0 && <WarningsList warnings={rest} />}
    </div>
  )
}

/** Passo 4: sequenza e contenuti. */
export function StepContent({
  campaign,
  steps,
  recipients,
  profile,
  aiReady,
  onChanged,
}: {
  campaign: CampaignRow
  steps: CampaignStepRow[]
  recipients: RecipientView[]
  profile: SalesProfileRow | null
  aiReady: boolean
  onChanged: () => void
}) {
  const { t } = useI18n()
  const preview = recipients.find((r) => r.status === 'eligible' || r.status === 'in_sequence') ?? null
  const senderOk = !!(profile?.sender_legal_name && profile.sender_address && profile.privacy_policy_url)
  const editable = ['draft', 'pending_approval'].includes(campaign.status)
  return (
    <div className="space-y-6">
      <p className="text-sm text-muted">{t('cm.content.intro')}</p>
      {!editable && <InlineAlert tone="signal">{t('cm.content.locked')}</InlineAlert>}
      {!senderOk && (
        <InlineAlert tone="signal">
          {t('cm.content.senderMissing')}{' '}
          <Link to="/app/sales-agent/profile" className="underline">
            {t('cm.content.senderCta')}
          </Link>
        </InlineAlert>
      )}
      <ol className="space-y-6">
        {steps.map((s) => (
          <li key={s.id} className="rounded-[var(--radius-panel)] border border-line p-4">
            <h3 className="mb-3 flex flex-wrap items-center gap-2 text-sm font-semibold">
              <Badge tone="neutral">{t('cm.content.day', { n: s.day_offset })}</Badge>
              {t(`cm.content.stepKinds.${s.kind}`)}
            </h3>
            {s.kind === 'email' || s.kind === 'follow_up_email' ? (
              <EmailStepEditor campaign={campaign} step={s} preview={preview} aiReady={aiReady} onSaved={onChanged} />
            ) : (
              <p className="text-sm text-muted">{t('cm.content.noInternal')}</p>
            )}
          </li>
        ))}
      </ol>
      {senderOk && (
        <section className="rounded-[var(--radius-panel)] border border-line bg-surface-2/50 p-4 text-xs text-muted">
          <h3 className="mb-1 font-semibold text-ink">{t('cm.content.footerPreview')}</h3>
          <p className="whitespace-pre-wrap">
            {[profile?.email_signature || '', `${profile?.sender_legal_name} · ${profile?.sender_address}`, profile?.privacy_policy_url ?? '', t('cm.content.unsubscribePlaceholder')].filter(Boolean).join('\n')}
          </p>
        </section>
      )}
    </div>
  )
}
