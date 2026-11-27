import { ExternalLink, ThumbsDown, ThumbsUp } from 'lucide-react'
import { cn } from '../../lib/cn'
import { useI18n } from '../../i18n'
import { Badge } from '../../components/ui/Badge'
import type { LeadView, Verdict } from './types'

/** Evidenzia nel testo le parole che hanno deciso la classificazione (prove testuali di demand.py). */
export function highlight(text: string, matches: string[]): { text: string; hit: boolean }[] {
  const words = [...new Set(matches.filter((m) => m && m.trim().length > 1))].sort((a, b) => b.length - a.length)
  if (!words.length) return [{ text, hit: false }]
  const escaped = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const re = new RegExp(`(${escaped.join('|')})`, 'gi')
  return text
    .split(re)
    .filter((p) => p !== '')
    .map((p) => ({ text: p, hit: words.some((w) => w.toLowerCase() === p.toLowerCase()) }))
}

const PRIORITY_TONE = { high: 'ok', medium: 'flow', low: 'neutral' } as const

export function LeadCard({
  lead,
  selected,
  onToggle,
  onVerdict,
  busy,
}: {
  lead: LeadView
  selected: boolean
  onToggle: () => void
  onVerdict: (v: Verdict | null) => void
  busy: boolean
}) {
  const { t } = useI18n()
  const evidence = lead.reading?.evidence ?? []
  const parts = highlight(lead.text, evidence.map((e) => e.match ?? ''))
  const canSelect = lead.status !== 'transferred' && !lead.simulated && lead.verdict !== 'sbagliato'
  const role = lead.reading?.author_role
  return (
    <article className={cn('rounded-[var(--radius-panel)] border bg-surface p-4 transition-colors', selected ? 'border-flow' : 'border-line')}>
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          className="mt-1 size-4 accent-[var(--color-flow)] disabled:opacity-40"
          checked={selected}
          disabled={!canSelect}
          onChange={onToggle}
          aria-label={lead.text.slice(0, 80)}
        />
        <div className="min-w-0 flex-1">
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            <span className="inline-flex items-baseline gap-1 rounded-full bg-surface-2 px-2.5 py-0.5 text-sm font-semibold tabular-nums" title={t('demandHunter.results.score')}>
              {lead.score}
              <span className="text-[11px] font-normal text-muted">/100</span>
            </span>
            <Badge tone={PRIORITY_TONE[lead.priority]}>{t(`demandHunter.results.priority.${lead.priority}`)}</Badge>
            {lead.stage && <Badge>{lead.stage.replace(/_/g, ' ')}</Badge>}
            {role && <Badge tone={role === 'buyer' ? 'ok' : 'danger'}>{t(`demandHunter.results.roles.${role}`)}</Badge>}
            {!lead.qualified && <Badge tone="danger">{t('demandHunter.results.notQualified')}</Badge>}
            {lead.simulated && <Badge tone="signal">{t('demandHunter.results.simulatedBadge')}</Badge>}
            {lead.status === 'transferred' && <Badge tone="ok">{t('demandHunter.results.transferred')}</Badge>}
          </div>
          <p className="text-sm leading-relaxed text-ink">
            {parts.map((p, i) =>
              p.hit ? (
                <mark key={i} className="rounded bg-signal-soft px-0.5 text-ink">
                  {p.text}
                </mark>
              ) : (
                <span key={i}>{p.text}</span>
              ),
            )}
          </p>
          {evidence.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
              <span className="text-muted">{t('demandHunter.results.evidence')}:</span>
              {evidence.slice(0, 8).map((e, i) => (
                <span key={i} className="rounded-full border border-line px-2 py-0.5">
                  <span className="text-muted">{e.signal}</span> · {e.match}
                </span>
              ))}
            </div>
          )}
          {lead.reasons.length > 0 && (
            <p className="mt-1.5 text-xs text-muted">{lead.reasons.map((r) => t(`demandHunter.results.reasons.${r}`)).join(' · ')}</p>
          )}
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0 text-xs text-muted">
              {lead.query && (
                <span className="block truncate">
                  {t('demandHunter.results.query')}: <code className="text-[11px]">{lead.query}</code>
                </span>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              <a href={lead.url} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-control)] px-2.5 text-sm text-flow hover:bg-flow-soft">
                <ExternalLink className="size-3.5" aria-hidden />
                {t('demandHunter.results.source')}
              </a>
              <button
                type="button"
                disabled={busy}
                aria-pressed={lead.verdict === 'giusto'}
                onClick={() => onVerdict(lead.verdict === 'giusto' ? null : 'giusto')}
                className={cn('inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-control)] border px-2.5 text-sm', lead.verdict === 'giusto' ? 'border-ok bg-ok-soft text-ok' : 'border-line hover:bg-surface-2')}
              >
                <ThumbsUp className="size-3.5" aria-hidden />
                {t('demandHunter.results.right')}
              </button>
              <button
                type="button"
                disabled={busy}
                aria-pressed={lead.verdict === 'sbagliato'}
                onClick={() => onVerdict(lead.verdict === 'sbagliato' ? null : 'sbagliato')}
                className={cn('inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-control)] border px-2.5 text-sm', lead.verdict === 'sbagliato' ? 'border-danger bg-danger-soft text-danger' : 'border-line hover:bg-surface-2')}
              >
                <ThumbsDown className="size-3.5" aria-hidden />
                {t('demandHunter.results.wrong')}
              </button>
            </div>
          </div>
        </div>
      </div>
    </article>
  )
}
