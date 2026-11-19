import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'

type Tone = 'neutral' | 'flow' | 'signal' | 'danger' | 'ok'
const tones: Record<Tone, string> = {
  neutral: 'bg-surface-2 text-muted',
  flow: 'bg-flow-soft text-flow',
  signal: 'bg-signal-soft text-signal',
  danger: 'bg-danger-soft text-danger',
  ok: 'bg-ok-soft text-ok',
}

export function Badge({ tone = 'neutral', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap', tones[tone], className)}>
      {children}
    </span>
  )
}
