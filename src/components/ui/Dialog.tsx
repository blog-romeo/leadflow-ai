import { useEffect, useId, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { cn } from '../../lib/cn'

/**
 * Dialog accessibile: role="dialog", focus iniziale e ripristino, Esc per chiudere,
 * focus trap semplice. Variante "drawer" a destra per i dettagli (a tutto schermo su mobile).
 */
export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  variant = 'center',
  closeLabel,
}: {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  footer?: ReactNode
  variant?: 'center' | 'drawer'
  closeLabel: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const titleId = useId()

  useEffect(() => {
    if (!open) return
    const previous = document.activeElement as HTMLElement | null
    const node = ref.current
    node?.querySelector<HTMLElement>('[data-autofocus], button, [href], input, select, textarea')?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'Tab' && node) {
        const items = [...node.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((el) => !el.hasAttribute('disabled'))
        if (!items.length) return
        const first = items[0]!
        const last = items[items.length - 1]!
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
      previous?.focus?.()
    }
  }, [open, onClose])

  if (!open) return null
  return (
    <div className="fixed inset-0 z-50">
      <button type="button" aria-hidden tabIndex={-1} className="absolute inset-0 bg-ink/40" onClick={onClose} />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={cn(
          'absolute flex flex-col bg-surface shadow-2xl',
          variant === 'drawer'
            ? 'inset-y-0 right-0 w-full sm:w-[min(40rem,92vw)] sm:border-l sm:border-line'
            : 'inset-x-3 top-[8vh] mx-auto max-h-[84vh] max-w-lg rounded-[var(--radius-panel)] border border-line',
        )}
      >
        <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5">
          <h2 id={titleId} className="truncate text-base font-semibold">
            {title}
          </h2>
          <button type="button" onClick={onClose} aria-label={closeLabel} className="grid size-9 shrink-0 place-items-center rounded-md hover:bg-surface-2">
            <X className="size-5" aria-hidden />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <footer className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-3">{footer}</footer>}
      </div>
    </div>
  )
}
