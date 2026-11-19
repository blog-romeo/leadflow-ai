import { useEffect, useState } from 'react'
import { useI18n } from '../i18n'
import { cn } from '../lib/cn'

const PATH = 'M 40 250 C 140 250, 150 170, 230 160 S 330 90, 420 80 S 520 40, 580 30'
const STAGES = [
  { x: 40, y: 250, key: 'landing.stageFound', note: { it: 'fonte e base giuridica', en: 'source and legal basis' } },
  { x: 230, y: 160, key: 'landing.stageAnalyzed', note: { it: 'profilo aziendale', en: 'company profile' } },
  { x: 420, y: 80, key: 'landing.stageQualified', note: { it: 'punteggio motivato', en: 'explained score' } },
  { x: 580, y: 30, key: 'landing.stageDeal', note: { it: 'attività e incontri', en: 'activities and meetings' } },
] as const

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(true)
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    setReduced(!!mq?.matches)
  }, [])
  return reduced
}

/**
 * Il percorso di un lead: una curva che sale per fasi.
 * Un unico segnale la percorre una volta al caricamento (assente con riduzione del movimento).
 */
export function FlowVisual({ className }: { className?: string }) {
  const { t, locale } = useI18n()
  const reduced = usePrefersReducedMotion()
  return (
    <figure className={cn('relative', className)}>
      <svg viewBox="0 -40 620 340" className="h-auto w-full overflow-visible" role="img" aria-label={t('landing.flowLabel')}>
        <defs>
          <pattern id="lf-dots" width="20" height="20" patternUnits="userSpaceOnUse">
            <circle cx="1" cy="1" r="1" className="fill-line" />
          </pattern>
        </defs>
        <rect x="0" y="-40" width="620" height="340" fill="url(#lf-dots)" opacity="0.9" />
        <path d={PATH} fill="none" className="stroke-line" strokeWidth="10" strokeLinecap="round" />
        <path d={PATH} fill="none" className="stroke-flow" strokeWidth="2.5" strokeLinecap="round" />
        {STAGES.map((s, i) => {
          const last = i === STAGES.length - 1
          // L'ultima fase ha l'etichetta sopra il nodo per non sovrapporsi alla curva.
          const titleY = last ? s.y - 38 : i === 0 ? s.y + 34 : s.y + 30
          const noteY = last ? s.y - 20 : i === 0 ? s.y + 54 : s.y + 50
          const x = last ? s.x : s.x + 18
          const anchor = last ? 'end' : 'start'
          return (
            <g key={s.key}>
              <circle cx={s.x} cy={s.y} r="11" className="fill-surface stroke-flow" strokeWidth="2.5" />
              <circle cx={s.x} cy={s.y} r="4" className={last ? 'fill-signal' : 'fill-flow'} />
              <text
                x={x}
                y={titleY}
                textAnchor={anchor}
                className="fill-ink font-display"
                fontSize="17"
                fontWeight="600"
              >
                {t(s.key)}
              </text>
              <text
                x={x}
                y={noteY}
                textAnchor={anchor}
                className="fill-muted"
                fontSize="13"
              >
                {s.note[locale]}
              </text>
            </g>
          )
        })}
        {!reduced && (
          <circle r="6" className="fill-signal">
            <animateMotion dur="3.2s" begin="0s" path={PATH} fill="freeze" calcMode="spline" keyTimes="0;1" keySplines="0.45 0 0.2 1" />
          </circle>
        )}
      </svg>
    </figure>
  )
}
