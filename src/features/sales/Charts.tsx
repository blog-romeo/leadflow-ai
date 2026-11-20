import { useState } from 'react'
import { useI18n } from '../../i18n'
import { cn } from '../../lib/cn'

/**
 * Grafici a serie singola (un solo colore: nessuna codifica categoriale).
 * Ogni grafico ha tooltip al passaggio/focus e una tabella dati per screen reader.
 */
export function BarList({ title, rows, highlight }: { title: string; rows: { key: string; label: string; value: number }[]; highlight?: (key: string) => 'ok' | 'danger' | undefined }) {
  const { t, formatNumber } = useI18n()
  const max = Math.max(1, ...rows.map((r) => r.value))
  return (
    <figure className="relative">
      <figcaption className="sr-only">{title}</figcaption>
      <ul className="space-y-1.5" aria-hidden>
        {rows.map((r) => {
          const tone = highlight?.(r.key)
          return (
            <li key={r.key} className="grid grid-cols-[minmax(7rem,10rem)_1fr_2.5rem] items-center gap-2 text-sm" title={`${r.label}: ${formatNumber(r.value)}`}>
              <span className="truncate text-muted">{r.label}</span>
              <span className="h-3 rounded-r-[4px] bg-surface-2">
                <span
                  className={cn('block h-full rounded-r-[4px]', tone === 'ok' ? 'bg-ok' : tone === 'danger' ? 'bg-danger/70' : 'bg-flow')}
                  style={{ width: r.value ? `${Math.max(2, (r.value / max) * 100)}%` : 0 }}
                />
              </span>
              <span className="tabular text-right font-medium">{formatNumber(r.value)}</span>
            </li>
          )
        })}
      </ul>
      <div className="sr-only">
      <table>
        <caption>{t('sales.charts.tableView')}: {title}</caption>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <th scope="row">{r.label}</th>
              <td>{r.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </figure>
  )
}

export function ColumnChart({ title, points }: { title: string; points: { label: string; value: number }[] }) {
  const { t, formatNumber } = useI18n()
  const [hover, setHover] = useState<number | null>(null)
  const max = Math.max(1, ...points.map((p) => p.value))
  const total = points.reduce((a, p) => a + p.value, 0)
  const W = 100 / Math.max(points.length, 1)
  return (
    <figure className="relative min-w-0">
      <figcaption className="mb-2 flex items-baseline justify-between gap-2 text-sm">
        <span className="sr-only">{title}</span>
        <span className="text-muted">{t('sales.charts.total')}</span>
        <span className="tabular font-display text-lg font-semibold">{formatNumber(total)}</span>
      </figcaption>
      {total === 0 ? (
        <p className="py-6 text-center text-sm text-muted">{t('sales.charts.noData')}</p>
      ) : (
        <div className="relative">
          <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="h-28 w-full" role="img" aria-label={title}>
            <line x1="0" y1="39.75" x2="100" y2="39.75" className="stroke-line" strokeWidth="0.5" vectorEffect="non-scaling-stroke" />
            {points.map((p, i) => {
              const h = (p.value / max) * 36
              return (
                <g key={i}>
                  {/* Area di hover più ampia della barra */}
                  <rect x={i * W} y="0" width={W} height="40" fill="transparent" onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} />
                  <rect x={i * W + W * 0.18} y={40 - h} width={W * 0.64} height={h} rx="0.8" className={hover === i ? 'fill-flow' : 'fill-flow/75'} pointerEvents="none" />
                </g>
              )
            })}
          </svg>
          {hover !== null && points[hover] && (
            <div role="status" className="pointer-events-none absolute -top-2 rounded-md border border-line bg-surface px-2 py-1 text-xs shadow" style={{ left: `min(calc(${hover * W}% ), calc(100% - 9rem))` }}>
              <span className="text-muted">{points[hover].label}</span> · <span className="font-semibold tabular">{formatNumber(points[hover].value)}</span>
            </div>
          )}
          <div className="mt-1 flex justify-between text-[11px] text-muted" aria-hidden>
            <span>{points[0]?.label}</span>
            <span>{points[points.length - 1]?.label}</span>
          </div>
        </div>
      )}
      <div className="sr-only">
      <table>
        <caption>{t('sales.charts.tableView')}: {title}</caption>
        <tbody>
          {points.map((p, i) => (
            <tr key={i}>
              <th scope="row">{p.label}</th>
              <td>{p.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </figure>
  )
}
