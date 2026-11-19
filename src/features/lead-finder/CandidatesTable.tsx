import { Ban, Eye, RotateCcw, Sparkles, UserPlus } from 'lucide-react'
import { ChevronLeft, ChevronRight, Search as SearchIcon } from 'lucide-react'
import { useI18n } from '../../i18n'
import { Badge } from '../../components/ui/Badge'
import { controlClasses, Select } from '../../components/ui/Field'
import { EmptyState, ErrorState, LoadingState } from '../../components/ui/States'
import { cn } from '../../lib/cn'
import { Radar } from 'lucide-react'
import { displayDomain, priorityTone, safeHref } from './format'
import type { CandidateView, Priority } from './types'

export interface TableFilters {
  scope: 'last' | 'all'
  q: string
  status: 'active' | 'new' | 'saved' | 'excluded'
  priority: '' | Priority
  provider: '' | 'osm_overpass' | 'google_places' | 'csv_import'
  sort: 'score' | 'name' | 'date'
}

function IconAction({ label, onClick, disabled, children, title, desktopOnly }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode; title?: string; desktopOnly?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={title ?? label}
      className={cn('size-8 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-35', desktopOnly ? 'hidden sm:grid' : 'grid')}
    >
      {children}
    </button>
  )
}

export function CandidatesTable(props: {
  rows: CandidateView[]
  total: number
  page: number
  pageSize: number
  loading: boolean
  error: string | null
  filters: TableFilters
  hasLastSearch: boolean
  selected: Set<string>
  jobs: Record<string, { status: string }>
  aiConfigured: boolean
  onFilters: (f: Partial<TableFilters>) => void
  onPage: (p: number) => void
  onToggle: (id: string) => void
  onToggleAll: (ids: string[], on: boolean) => void
  onDetails: (c: CandidateView) => void
  onAnalyze: (c: CandidateView) => void
  onSave: (ids: string[]) => void
  onExclude: (ids: string[], excluded: boolean) => void
  onRetry: () => void
}) {
  const { t, formatDate, formatNumber } = useI18n()
  const { rows, filters: f } = props
  const totalPages = Math.max(1, Math.ceil(props.total / props.pageSize))
  const pageIds = rows.map((r) => r.id)
  const allSelected = pageIds.length > 0 && pageIds.every((id) => props.selected.has(id))

  return (
    <div className="rounded-[var(--radius-panel)] border border-line bg-surface">
      <div className="flex flex-col gap-3 border-b border-line p-3 lg:flex-row lg:flex-wrap lg:items-center">
        <div role="radiogroup" aria-label={t('leadFinder.resultsTitle')} className="inline-flex shrink-0 rounded-[var(--radius-control)] border border-line p-0.5 text-sm">
          {(['last', 'all'] as const).map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={f.scope === s}
              disabled={s === 'last' && !props.hasLastSearch}
              onClick={() => props.onFilters({ scope: s })}
              className={cn('rounded-md px-3 py-1.5 disabled:opacity-40', f.scope === s ? 'bg-flow-soft font-medium text-flow' : 'text-muted hover:text-ink')}
            >
              {s === 'last' ? t('leadFinder.scopeLast') : t('leadFinder.scopeAll')}
            </button>
          ))}
        </div>
        <div className="relative min-w-0 flex-1 lg:min-w-[16rem]">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden />
          <label htmlFor="cand-search" className="sr-only">
            {t('leadFinder.searchPh')}
          </label>
          <input id="cand-search" type="search" value={f.q} onChange={(e) => props.onFilters({ q: e.target.value })} placeholder={t('leadFinder.searchPh')} className={cn(controlClasses, 'pl-9')} maxLength={120} />
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:w-full xl:w-auto xl:flex">
          <Select label={t('leadFinder.filterStatus')} hideLabel value={f.status} onChange={(e) => props.onFilters({ status: e.target.value as TableFilters['status'] })}>
            <option value="active">{t('leadFinder.filterStatus')}: {t('common.all')}</option>
            <option value="new">{t('leadFinder.status.new')}</option>
            <option value="saved">{t('leadFinder.status.saved')}</option>
            <option value="excluded">{t('leadFinder.status.excluded')}</option>
          </Select>
          <Select label={t('leadFinder.filterPriority')} hideLabel value={f.priority} onChange={(e) => props.onFilters({ priority: e.target.value as TableFilters['priority'] })}>
            <option value="">{t('leadFinder.filterPriority')}: {t('common.all')}</option>
            {(['high', 'medium', 'low'] as const).map((p) => (
              <option key={p} value={p}>
                {t(`leadFinder.priority.${p}`)}
              </option>
            ))}
          </Select>
          <Select label={t('leadFinder.filterProvider')} hideLabel value={f.provider} onChange={(e) => props.onFilters({ provider: e.target.value as TableFilters['provider'] })}>
            <option value="">{t('leadFinder.filterProvider')}: {t('common.all')}</option>
            {(['osm_overpass', 'google_places', 'csv_import'] as const).map((p) => (
              <option key={p} value={p}>
                {t(`leadFinder.providers.${p}`)}
              </option>
            ))}
          </Select>
          <Select label={t('leadFinder.sortBy')} hideLabel value={f.sort} onChange={(e) => props.onFilters({ sort: e.target.value as TableFilters['sort'] })}>
            <option value="score">{t('leadFinder.sortBy')}: {t('leadFinder.sortScore')}</option>
            <option value="name">{t('leadFinder.sortBy')}: {t('leadFinder.sortName')}</option>
            <option value="date">{t('leadFinder.sortBy')}: {t('leadFinder.sortDate')}</option>
          </Select>
        </div>
      </div>

      {props.loading ? (
        <LoadingState />
      ) : props.error ? (
        <ErrorState message={props.error} onRetry={props.onRetry} />
      ) : rows.length === 0 ? (
        <EmptyState icon={Radar} title={f.q || f.priority || f.provider || f.status !== 'active' ? t('leadFinder.emptyFiltered') : t('leadFinder.emptyTitle')} body={f.q ? undefined : t('leadFinder.emptyBody')} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm sm:min-w-[640px]">
            <caption className="sr-only">{t('leadFinder.resultsTitle')}</caption>
            <thead>
              <tr className="border-b border-line text-xs text-muted">
                <th scope="col" className="w-10 px-3 py-2.5">
                  <input type="checkbox" aria-label={t('leadFinder.selectAll')} checked={allSelected} onChange={(e) => props.onToggleAll(pageIds, e.target.checked)} className="size-4 accent-[var(--lf-flow)]" />
                </th>
                <th scope="col" className="px-3 py-2.5 font-medium">{t('leadFinder.colCompany')}</th>
                <th scope="col" className="hidden px-3 py-2.5 font-medium xl:table-cell">{t('leadFinder.colSector')}</th>
                <th scope="col" className="hidden px-3 py-2.5 font-medium md:table-cell">{t('leadFinder.colWebsite')}</th>
                <th scope="col" className="hidden px-3 py-2.5 font-medium lg:table-cell">{t('leadFinder.colSource')}</th>
                <th scope="col" className="px-2 py-2.5 text-right font-medium sm:px-3">{t('leadFinder.colScore')}</th>
                <th scope="col" className="hidden px-3 py-2.5 font-medium sm:table-cell">{t('leadFinder.colPriority')}</th>
                <th scope="col" className="hidden px-3 py-2.5 font-medium lg:table-cell">{t('leadFinder.colDate')}</th>
                <th scope="col" className="px-3 py-2.5 text-right font-medium">{t('leadFinder.colActions')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const score = r.sessionScore?.score ?? r.score
                const priority = r.sessionScore?.priority ?? r.priority
                const basis = r.sessionScore?.basis ?? r.score_basis
                const href = safeHref(r.website)
                const job = props.jobs[r.id]
                const busy = job && (job.status === 'queued' || job.status === 'running')
                const name = r.company_name ?? `${t(`leadFinder.providers.${r.provider}`)} · ${r.external_id.slice(0, 12)}…`
                return (
                  <tr key={r.id} className={cn('border-b border-line last:border-0 hover:bg-surface-2/60', r.status === 'excluded' && 'text-muted')}>
                    <td className="px-3 py-2.5">
                      <input type="checkbox" aria-label={t('leadFinder.selectRow', { name })} checked={props.selected.has(r.id)} onChange={() => props.onToggle(r.id)} className="size-4 accent-[var(--lf-flow)]" />
                    </td>
                    <td className="max-w-[9rem] px-2 py-2.5 sm:max-w-[16rem] sm:px-3">
                      <button type="button" onClick={() => props.onDetails(r)} className="block max-w-full truncate text-left font-medium hover:text-flow hover:underline">
                        {name}
                      </button>
                      <p className="truncate text-xs text-muted">
                        {[r.city, r.country].filter(Boolean).join(', ') || (r.sessionOnly && !r.company_name ? t('leadFinder.sessionOnly').split('.')[0] : '')}
                      </p>
                      {r.status !== 'new' && <Badge tone={r.status === 'saved' ? 'flow' : 'danger'} className="mt-1">{t(`leadFinder.status.${r.status}`)}</Badge>}
                    </td>
                    <td className="hidden max-w-[10rem] truncate px-3 py-2.5 xl:table-cell">{r.sector ?? '—'}</td>
                    <td className="hidden max-w-[12rem] truncate px-3 py-2.5 md:table-cell">
                      {href ? (
                        <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="text-flow hover:underline">
                          {displayDomain(r.website)}
                        </a>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                    <td className="hidden px-3 py-2.5 lg:table-cell">
                      <span className="text-xs">{t(`leadFinder.providers.${r.provider}`)}</span>
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      {score === null || score === undefined ? (
                        <span className="text-muted">—</span>
                      ) : (
                        <span className="tabular inline-flex flex-col items-end font-display text-base font-semibold">
                          {formatNumber(score)}
                          {basis === 'rules' && (
                            <span className="block text-[11px] font-normal text-muted" title={t('leadFinder.preliminaryHint')}>
                              {t('leadFinder.preliminary')}
                            </span>
                          )}
                          {priority && <Badge tone={priorityTone[priority]} className="mt-1 sm:hidden">{t(`leadFinder.priority.${priority}`)}</Badge>}
                        </span>
                      )}
                    </td>
                    <td className="hidden px-3 py-2.5 sm:table-cell">{priority ? <Badge tone={priorityTone[priority]}>{t(`leadFinder.priority.${priority}`)}</Badge> : <span className="text-muted">—</span>}</td>
                    <td className="hidden whitespace-nowrap px-3 py-2.5 text-xs text-muted lg:table-cell">
                      <time dateTime={r.last_seen_at}>{formatDate(r.last_seen_at)}</time>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex justify-end gap-0.5">
                        <IconAction label={t('leadFinder.actDetails')} onClick={() => props.onDetails(r)}>
                          <Eye className="size-4" aria-hidden />
                        </IconAction>
                        <IconAction label={t('leadFinder.actAnalyze')} onClick={() => props.onAnalyze(r)} disabled={!props.aiConfigured || !!busy || r.status === 'excluded' || (r.sessionOnly && !r.company_name)}>
                          <Sparkles className={cn('size-4', busy && 'animate-pulse text-flow')} aria-hidden />
                        </IconAction>
                        <IconAction
                          label={t('leadFinder.actSave')}
                          desktopOnly
                          title={!r.can_save_to_crm ? t('leadFinder.saveNotAllowed') : undefined}
                          onClick={() => props.onSave([r.id])}
                          disabled={!r.can_save_to_crm || r.status !== 'new'}
                        >
                          <UserPlus className="size-4" aria-hidden />
                        </IconAction>
                        {r.status === 'excluded' ? (
                          <IconAction desktopOnly label={t('leadFinder.actRestore')} onClick={() => props.onExclude([r.id], false)}>
                            <RotateCcw className="size-4" aria-hidden />
                          </IconAction>
                        ) : (
                          <IconAction desktopOnly label={t('leadFinder.actExclude')} onClick={() => props.onExclude([r.id], true)} disabled={r.status === 'saved'}>
                            <Ban className="size-4" aria-hidden />
                          </IconAction>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <nav aria-label={t('common.pageOf', { page: props.page, total: totalPages })} className="flex items-center justify-between gap-3 border-t border-line px-4 py-2.5 text-sm text-muted">
        <span className="tabular">{t('common.results', { count: formatNumber(props.total) })}</span>
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => props.onPage(props.page - 1)} disabled={props.page <= 1 || props.loading} aria-label={t('common.previous')} className="grid size-8 place-items-center rounded-md hover:bg-surface-2 disabled:opacity-40">
            <ChevronLeft className="size-4" aria-hidden />
          </button>
          <span className="tabular px-1" aria-live="polite">
            {t('common.pageOf', { page: props.page, total: totalPages })}
          </span>
          <button type="button" onClick={() => props.onPage(props.page + 1)} disabled={props.page >= totalPages || props.loading} aria-label={t('common.next')} className="grid size-8 place-items-center rounded-md hover:bg-surface-2 disabled:opacity-40">
            <ChevronRight className="size-4" aria-hidden />
          </button>
        </div>
      </nav>
    </div>
  )
}
