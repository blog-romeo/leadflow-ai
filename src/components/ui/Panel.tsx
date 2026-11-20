import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'

/** Contenitore di sezione. Il titolo è un vero heading per la navigazione assistita. */
export function Panel({
  title,
  action,
  children,
  className,
  as: Heading = 'h2',
}: {
  title?: string
  action?: ReactNode
  children: ReactNode
  className?: string
  as?: 'h2' | 'h3'
}) {
  return (
    <section className={cn('min-w-0 rounded-[var(--radius-panel)] border border-line bg-surface', className)}>
      {title && (
        <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5">
          <Heading className="text-base font-semibold">{title}</Heading>
          {action}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  )
}
