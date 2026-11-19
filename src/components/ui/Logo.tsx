import { cn } from '../../lib/cn'

/** Marchio: una curva di flusso che termina in un punto-segnale. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn('size-8 shrink-0', className)} aria-hidden>
      <rect width="32" height="32" rx="8" className="fill-flow" />
      <path d="M7 21c4 0 5-10 9-10s5 10 9 10" fill="none" className="stroke-flow-ink" strokeWidth="2.6" strokeLinecap="round" />
      <circle cx="25" cy="21" r="2.6" fill="#F2B33D" />
    </svg>
  )
}

export function Logo({ className, compact }: { className?: string; compact?: boolean }) {
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <LogoMark />
      {!compact && <span className="font-display text-lg font-semibold tracking-tight">LeadFlow AI</span>}
    </span>
  )
}
