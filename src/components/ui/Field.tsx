import { forwardRef, useId, type InputHTMLAttributes, type SelectHTMLAttributes, type ReactNode } from 'react'
import { cn } from '../../lib/cn'

const control =
  'w-full rounded-[var(--radius-control)] border border-line bg-surface px-3 h-10 text-sm text-ink placeholder:text-muted/80 transition-colors focus:border-flow focus:outline-none focus:ring-2 focus:ring-flow/25 disabled:opacity-60 aria-[invalid=true]:border-danger'

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string
  hint?: string
  error?: string | null
}

export const Field = forwardRef<HTMLInputElement, FieldProps>(function Field({ label, hint, error, className, id, ...rest }, ref) {
  const autoId = useId()
  const inputId = id ?? autoId
  const describedBy = [hint ? `${inputId}-hint` : null, error ? `${inputId}-error` : null].filter(Boolean).join(' ') || undefined
  return (
    <div className={cn('space-y-1.5', className)}>
      <label htmlFor={inputId} className="block text-sm font-medium text-ink">
        {label}
      </label>
      <input ref={ref} id={inputId} aria-invalid={!!error || undefined} aria-describedby={describedBy} className={control} {...rest} />
      {hint && !error && (
        <p id={`${inputId}-hint`} className="text-xs text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${inputId}-error`} role="alert" className="text-xs font-medium text-danger">
          {error}
        </p>
      )}
    </div>
  )
})

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label: string
  children: ReactNode
  hideLabel?: boolean
}

export function Select({ label, children, className, id, hideLabel, ...rest }: SelectProps) {
  const autoId = useId()
  const selectId = id ?? autoId
  return (
    <div className={cn('space-y-1.5', className)}>
      <label htmlFor={selectId} className={hideLabel ? 'sr-only' : 'block text-sm font-medium text-ink'}>
        {label}
      </label>
      <select id={selectId} className={cn(control, 'pr-8')} {...rest}>
        {children}
      </select>
    </div>
  )
}

export { control as controlClasses }
