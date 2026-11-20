import { ExternalLink, Sparkles } from 'lucide-react'
import { Link } from 'react-router-dom'
import type { ReactNode } from 'react'
import { useI18n } from '../../i18n'
import { Dialog } from '../../components/ui/Dialog'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { InlineAlert } from '../../components/ui/States'
import { cn } from '../../lib/cn'
import type { AnalysisResult, CandidateView, ScoreResult } from './types'
import { priorityTone, safeHref } from './format'

function Section({ title, children, note }: { title: string; children: ReactNode; note?: string }) {
  return (
    <section className="mt-5">
      <h3 className="text-sm font-semibold">{title}</h3>
      {note && <p className="mt-0.5 text-xs text-muted">{note}</p>}
      <div className="mt-2">{children}</div>
    </section>
  )
}

function ScoreBreakdown({ score }: { score: ScoreResult }) {
  const { t } = useI18n()
  return (
    <ul className="space-y-3">
      {score.breakdown.map((b) => (
        <li key={b.key}>
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="font-medium">{t(`leadFinder.criteria.${b.key}`)}</span>
            <span className="tabular text-muted">
              {b.points}/{b.max}
            </span>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2" role="presentation">
            <div className="h-full rounded-full bg-flow" style={{ width: `${b.max ? (b.points / b.max) * 100 : 0}%` }} />
          </div>
          <p className="mt-1 text-xs text-muted">{t(`leadFinder.reasons.${b.reason}`, b.params as Record<string, string | number>)}</p>
          {b.aiReason && <p className="mt-0.5 text-xs">{b.aiReason}</p>}
          {b.evidence.length > 0 && <p className="mt-0.5 truncate text-xs text-muted">{b.evidence.join(' · ')}</p>}
        </li>
      ))}
    </ul>
  )
}

function AnalysisView({ a }: { a: AnalysisResult }) {
  const { t, formatDate } = useI18n()
  const basis = (b: string) => (
    <Badge tone={b === 'verified' ? 'ok' : b === 'hypothesis' ? 'signal' : 'neutral'}>{t(`leadFinder.details.basis.${b}`)}</Badge>
  )
  return (
    <>
      <p className="text-xs text-muted">
        {t(`leadFinder.details.websiteStatus.${a.website.status}`)} · {t('leadFinder.details.model', { model: a.model, date: formatDate(a.analyzed_at) })}
      </p>
      <dl className="mt-3 grid gap-2 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <dt className="text-muted">{t('leadFinder.details.sectorAi')}:</dt>
          <dd className="flex items-center gap-2">{a.sector.value || '—'} {basis(a.sector.basis)}</dd>
        </div>
        <div>
          <dt className="flex items-center gap-2 text-muted">
            {t('leadFinder.details.activity')} {basis(a.activity_description.basis)}
          </dt>
          <dd className="mt-0.5">{a.activity_description.value || '—'}</dd>
        </div>
      </dl>
      <Section title={t('leadFinder.details.verifiedFacts')}>
        <ul className="space-y-1.5 text-sm">
          {a.verified_facts.map((f, i) => (
            <li key={i}>
              {f.statement}: <span className="text-muted">“{f.evidence}”</span>{' '}
              <Badge tone="neutral">{f.source === 'website' ? t('leadFinder.details.fromWebsite') : t('leadFinder.details.fromProvider')}</Badge>
            </li>
          ))}
        </ul>
      </Section>
      {a.signals.length > 0 && (
        <Section title={t('leadFinder.criteria.signals')}>
          <ul className="space-y-1.5 text-sm">
            {a.signals.map((s, i) => (
              <li key={i} className={cn(!s.verified && 'text-muted line-through')}>
                {s.signal}: “{s.evidence}” {!s.verified && <span className="no-underline">({t('leadFinder.details.signalUnverified')})</span>}
              </li>
            ))}
          </ul>
        </Section>
      )}
      {a.hypotheses.length > 0 && (
        <Section title={t('leadFinder.details.hypotheses')}>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {a.hypotheses.map((h, i) => (
              <li key={i}>
                {h.statement} <span className="text-muted">— {h.rationale}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {a.digital_needs.length > 0 && (
        <Section title={t('leadFinder.details.digitalNeeds')} note={t('leadFinder.details.digitalNeedsNote')}>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {a.digital_needs.map((d, i) => (
              <li key={i}>
                {d.need} <span className="text-muted">— {d.rationale}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {a.opportunities.length > 0 && (
        <Section title={t('leadFinder.details.opportunities')}>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {a.opportunities.map((o, i) => (
              <li key={i}>
                {o.opportunity} <span className="text-muted">— {o.rationale}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {a.missing_information.length > 0 && (
        <Section title={t('leadFinder.details.missing')}>
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
            {a.missing_information.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        </Section>
      )}
      <Section title={t('leadFinder.details.reasoning')}>
        <p className="text-sm">{a.qualification_reason}</p>
      </Section>
    </>
  )
}

export function CandidateDetails({
  candidate,
  analysis,
  score,
  jobStatus,
  onClose,
  onAnalyze,
  onSave,
  aiConfigured,
}: {
  candidate: CandidateView | null
  analysis: AnalysisResult | null
  score: ScoreResult | null
  jobStatus: { status: string; error?: string | null } | null
  onClose: () => void
  onAnalyze: () => void
  onSave: () => void
  aiConfigured: boolean
}) {
  const { t, formatDate } = useI18n()
  if (!candidate) return null
  const c = candidate
  const href = safeHref(c.website)
  const running = jobStatus && (jobStatus.status === 'queued' || jobStatus.status === 'running')
  return (
    <Dialog
      open
      variant="drawer"
      onClose={onClose}
      title={c.company_name ?? t('leadFinder.details.title')}
      closeLabel={t('leadFinder.details.close')}
      footer={
        <>
          <Button variant="secondary" onClick={onAnalyze} disabled={!aiConfigured || !!running || c.status === 'excluded' || (c.sessionOnly && !c.company_name)} loading={!!running}>
            <Sparkles className="size-4" aria-hidden />
            {t('leadFinder.actAnalyze')}
          </Button>
          <Button onClick={onSave} disabled={!c.can_save_to_crm || c.status !== 'new'} title={!c.can_save_to_crm ? t('leadFinder.saveNotAllowed') : undefined}>
            {t('leadFinder.actSave')}
          </Button>
        </>
      }
    >
      {c.sessionOnly && !c.company_name && <InlineAlert tone="signal">{t('leadFinder.sessionOnly')}</InlineAlert>}
      {c.lead_id && (
        <Link to={`/app/sales-agent/leads/${c.lead_id}`} className="mb-2 inline-flex items-center gap-1 text-sm font-medium text-flow hover:underline">
          {t('leadFinder.openInSalesAgent')}
        </Link>
      )}
      <Section title={t('leadFinder.details.company')}>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
          <dt className="text-muted">{t('leadFinder.colSector')}</dt>
          <dd>{c.sector ?? '—'}</dd>
          <dt className="text-muted">{t('leadFinder.colLocation')}</dt>
          <dd>{[c.address, c.city, c.country].filter(Boolean).join(', ') || '—'}</dd>
          <dt className="text-muted">{t('leadFinder.colWebsite')}</dt>
          <dd className="min-w-0 truncate">
            {href ? (
              <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="text-flow hover:underline">
                {c.website}
              </a>
            ) : (
              '—'
            )}
          </dd>
          <dt className="text-muted">{t('leadFinder.colPhone')}</dt>
          <dd>{c.phone ?? '—'}</dd>
        </dl>
      </Section>
      <Section title={t('leadFinder.details.source')}>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
          <dt className="text-muted">{t('leadFinder.colSource')}</dt>
          <dd>
            {t(`leadFinder.providers.${c.provider}`)}
            {c.attribution && <span className="text-muted"> · {c.attribution}</span>}
          </dd>
          <dt className="text-muted">{t('leadFinder.details.externalId')}</dt>
          <dd className="truncate font-mono text-xs leading-5">{c.external_id}</dd>
          <dt className="text-muted">{t('leadFinder.details.acquired')}</dt>
          <dd>{formatDate(c.acquired_at)}</dd>
        </dl>
        {safeHref(c.source_url) && (
          <a href={safeHref(c.source_url)!} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex items-center gap-1 text-sm text-flow hover:underline">
            {t('leadFinder.details.viewSource')} <ExternalLink className="size-3.5" aria-hidden />
          </a>
        )}
      </Section>
      {score && (
        <Section title={t('leadFinder.details.scoreTitle')}>
          <p className="mb-3 flex items-center gap-2 text-sm font-medium">
            {t('leadFinder.details.scoreTotal', { score: score.score, priority: t(`leadFinder.priority.${score.priority}`).toLowerCase() })}
            <Badge tone={priorityTone[score.priority]}>{t(`leadFinder.priority.${score.priority}`)}</Badge>
            {score.basis === 'rules' && <Badge tone="neutral">{t('leadFinder.preliminary')}</Badge>}
          </p>
          <ScoreBreakdown score={score} />
        </Section>
      )}
      <Section title={t('leadFinder.details.analysisTitle')}>
        {jobStatus?.status === 'failed' && <InlineAlert>{t('leadFinder.analysisFailed', { code: jobStatus.error ?? '—' })}</InlineAlert>}
        {running && (
          <p role="status" className="text-sm text-muted">
            {jobStatus.status === 'queued' ? t('leadFinder.analysisQueued') : t('leadFinder.analysisRunning')}
          </p>
        )}
        {analysis ? <AnalysisView a={analysis} /> : !running && <p className="text-sm text-muted">{t('leadFinder.details.noAnalysis')}</p>}
      </Section>
    </Dialog>
  )
}
