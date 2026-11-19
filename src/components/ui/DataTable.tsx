import type { ReactNode } from 'react'
import { ChevronLeft, ChevronRight, Search } from 'lucide-react'
import { useI18n } from '../../i18n'
import { cn } from '../../lib/cn'
import { controlClasses } from './Field'
import { ErrorState, LoadingState } from './States'

export interface Column<T> {
  key: string
  header: string
  render: (row: T) => ReactNode
  /** Nasconde la colonna sotto il breakpoint md per mantenere leggibile la tabella su mobile. */
  hideOnMobile?: boolean
  align?: 'left' | 'right'
}

interface DataTableProps<T> {
  caption: string
  columns: Column<T>[]
  rows: T[]
  rowKey: (row: T) => string
  loading?: boolean
  error?: string | null
  onRetry?: () => void
  search?: { value: string; onChange: (v: string) => void; placeholder: string }
  filters?: ReactNode
  page: number
  pageSize: number
  total: number
  onPageChange: (page: number) => void
  empty: ReactNode
}

/**
 * Tabella con ricerca, filtri e paginazione lato server.
 * Non conosce l'origine dei dati: riceve righe reali già filtrate dalle policy RLS.
 */
export function DataTable<T>({
  caption,
  columns,
  rows,
  rowKey,
  loading,
  error,
  onRetry,
  search,
  filters,
  page,
  pageSize,
  total,
  onPageChange,
  empty,
}: DataTableProps<T>) {
  const { t, formatNumber } = useI18n()
  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  return (
    <div className="rounded-[var(--radius-panel)] border border-line bg-surface">
      {(search || filters) && (
        <div className="flex flex-col gap-3 border-b border-line p-3 sm:flex-row sm:items-center">
          {search && (
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden />
              <label className="sr-only" htmlFor="table-search">
                {t('common.search')}
              </label>
              <input
                id="table-search"
                type="search"
                value={search.value}
                onChange={(e) => search.onChange(e.target.value)}
                placeholder={search.placeholder}
                className={cn(controlClasses, 'pl-9')}
                maxLength={120}
              />
            </div>
          )}
          {filters && <div className="flex flex-wrap gap-2">{filters}</div>}
        </div>
      )}

      {loading ? (
        <LoadingState />
      ) : error ? (
        <ErrorState message={error} onRetry={onRetry} />
      ) : rows.length === 0 ? (
        empty
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">{caption}</caption>
            <thead>
              <tr className="border-b border-line text-xs text-muted">
                {columns.map((c) => (
                  <th
                    key={c.key}
                    scope="col"
                    className={cn('px-4 py-2.5 font-medium', c.hideOnMobile && 'hidden md:table-cell', c.align === 'right' && 'text-right')}
                  >
                    {c.header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={rowKey(row)} className="border-b border-line last:border-0 hover:bg-surface-2/60">
                  {columns.map((c) => (
                    <td key={c.key} className={cn('px-4 py-3', c.hideOnMobile && 'hidden md:table-cell', c.align === 'right' && 'text-right tabular')}>
                      {c.render(row)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <nav aria-label={t('common.pageOf', { page, total: totalPages })} className="flex items-center justify-between gap-3 border-t border-line px-4 py-2.5 text-sm text-muted">
        <span className="tabular">{t('common.results', { count: formatNumber(total) })}</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => onPageChange(page - 1)}
            disabled={page <= 1 || loading}
            aria-label={t('common.previous')}
            className="grid size-8 place-items-center rounded-md hover:bg-surface-2 disabled:opacity-40"
          >
            <ChevronLeft className="size-4" aria-hidden />
          </button>
          <span className="tabular px-1" aria-live="polite">
            {t('common.pageOf', { page, total: totalPages })}
          </span>
          <button
            type="button"
            onClick={() => onPageChange(page + 1)}
            disabled={page >= totalPages || loading}
            aria-label={t('common.next')}
            className="grid size-8 place-items-center rounded-md hover:bg-surface-2 disabled:opacity-40"
          >
            <ChevronRight className="size-4" aria-hidden />
          </button>
        </div>
      </nav>
    </div>
  )
}
