import { Monitor, Moon, Sun } from 'lucide-react'
import { useTheme, type ThemePreference } from '../../contexts/ThemeContext'
import { useI18n, LOCALES, type Locale } from '../../i18n'
import { cn } from '../../lib/cn'

export function ThemeToggle({ className }: { className?: string }) {
  const { resolved, setPreference } = useTheme()
  const { t } = useI18n()
  const next: ThemePreference = resolved === 'dark' ? 'light' : 'dark'
  const label = next === 'dark' ? t('common.themeDark') : t('common.themeLight')
  return (
    <button
      type="button"
      onClick={() => setPreference(next)}
      aria-label={label}
      title={label}
      className={cn('grid size-9 place-items-center rounded-[var(--radius-control)] text-muted hover:bg-surface-2 hover:text-ink', className)}
    >
      {resolved === 'dark' ? <Sun className="size-4" aria-hidden /> : <Moon className="size-4" aria-hidden />}
    </button>
  )
}

export function ThemeSegmented() {
  const { preference, setPreference } = useTheme()
  const { t } = useI18n()
  const options: { value: ThemePreference; label: string; Icon: typeof Sun }[] = [
    { value: 'light', label: t('common.themeLight'), Icon: Sun },
    { value: 'dark', label: t('common.themeDark'), Icon: Moon },
    { value: 'system', label: t('common.themeSystem'), Icon: Monitor },
  ]
  return (
    <div role="radiogroup" aria-label={t('settings.theme')} className="inline-flex flex-wrap gap-1 rounded-[var(--radius-control)] border border-line p-1">
      {options.map(({ value, label, Icon }) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={preference === value}
          onClick={() => setPreference(value)}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm',
            preference === value ? 'bg-flow-soft font-medium text-flow' : 'text-muted hover:text-ink',
          )}
        >
          <Icon className="size-4" aria-hidden />
          {label}
        </button>
      ))}
    </div>
  )
}

export function LanguageSwitch({ className }: { className?: string }) {
  const { locale, setLocale, t } = useI18n()
  return (
    <div role="radiogroup" aria-label={t('common.language')} className={cn('inline-flex rounded-[var(--radius-control)] border border-line p-0.5 text-xs', className)}>
      {LOCALES.map((l: Locale) => (
        <button
          key={l}
          type="button"
          role="radio"
          aria-checked={locale === l}
          onClick={() => setLocale(l)}
          className={cn('rounded-md px-2 py-1 font-medium uppercase', locale === l ? 'bg-surface-2 text-ink' : 'text-muted hover:text-ink')}
        >
          {l}
        </button>
      ))}
    </div>
  )
}
