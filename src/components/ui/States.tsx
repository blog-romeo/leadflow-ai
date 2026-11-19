import type { ReactNode } from 'react'
import { LoaderCircle, TriangleAlert, type LucideIcon } from 'lucide-react'
import { useI18n } from '../../i18n'
import { Button } from './Button'
import { cn } from '../../lib/cn'

export function LoadingState({ label, className }: { label?: string; className?: string }) {
  const { t } = useI18n()
  return (
    <div role="status" aria-live="polite" className={cn('flex items-center justify-center gap-2 py-10 text-sm text-muted', className)}>
      <LoaderCircle className="size-4 animate-spin" aria-hidden />
      {label ?? t('common.loading')}
    </div>
  )
}

export function FullPageLoader() {
  return (
    <div className="grid min-h-dvh place-items-center bg-bg">
      <LoadingState />
    </div>
  )
}

export function EmptyState({
  icon: Icon,
  title,
  body,
  action,
  className,
}: {
  icon: LucideIcon
  title: string
  body?: string
  action?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex flex-col items-center px-4 py-10 text-center', className)}>
      <div className="mb-4 grid size-11 place-items-center rounded-full border border-dashed border-line text-muted">
        <Icon className="size-5" aria-hidden />
      </div>
      <p className="font-display text-base font-semibold">{title}</p>
      {body && <p className="mt-1 max-w-sm text-sm text-muted">{body}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

export function ErrorState({ message, onRetry, className }: { message: string; onRetry?: () => void; className?: string }) {
  const { t } = useI18n()
  return (
    <div role="alert" className={cn('flex flex-col items-center gap-3 px-4 py-8 text-center', className)}>
      <TriangleAlert className="size-5 text-danger" aria-hidden />
      <p className="max-w-sm text-sm text-ink">{message}</p>
      {onRetry && (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          {t('common.retry')}
        </Button>
      )}
    </div>
  )
}

export function InlineAlert({ tone = 'danger', children }: { tone?: 'danger' | 'ok' | 'signal'; children: ReactNode }) {
  const styles = { danger: 'bg-danger-soft text-danger', ok: 'bg-ok-soft text-ok', signal: 'bg-signal-soft text-signal' }[tone]
  return (
    <div role={tone === 'danger' ? 'alert' : 'status'} className={cn('rounded-[var(--radius-control)] px-3 py-2.5 text-sm font-medium', styles)}>
      {children}
    </div>
  )
}
