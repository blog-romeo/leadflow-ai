import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { it, type Dictionary } from './it'
import { en } from './en'

export type Locale = 'it' | 'en'
export const LOCALES: Locale[] = ['it', 'en']
const dictionaries: Record<Locale, Dictionary> = { it, en }
const STORAGE_KEY = 'lf-locale'

type Vars = Record<string, string | number>

/** Risolve una chiave puntata ("dashboard.title") in un dizionario. */
export function lookup(dict: Dictionary, key: string): unknown {
  return key.split('.').reduce<unknown>((acc, part) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[part] : undefined), dict)
}

export function interpolate(template: string, vars?: Vars): string {
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (_, k: string) => (k in vars ? String(vars[k]) : `{${k}}`))
}

export function translate(locale: Locale, key: string, vars?: Vars): string {
  const value = lookup(dictionaries[locale], key) ?? lookup(dictionaries.it, key)
  return typeof value === 'string' ? interpolate(value, vars) : key
}

interface I18nValue {
  locale: Locale
  setLocale: (l: Locale) => void
  t: (key: string, vars?: Vars) => string
  list: (key: string) => readonly string[]
  formatDate: (iso: string) => string
  formatNumber: (n: number) => string
}

const I18nContext = createContext<I18nValue | null>(null)

function initialLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved === 'it' || saved === 'en') return saved
  } catch {
    /* storage non disponibile */
  }
  return 'it'
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale)

  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l)
    try {
      localStorage.setItem(STORAGE_KEY, l)
    } catch {
      /* ignore */
    }
  }, [])

  const value = useMemo<I18nValue>(() => {
    const tag = locale === 'it' ? 'it-IT' : 'en-GB'
    const dateFmt = new Intl.DateTimeFormat(tag, { day: '2-digit', month: 'short', year: 'numeric' })
    const numFmt = new Intl.NumberFormat(tag)
    return {
      locale,
      setLocale,
      t: (key, vars) => translate(locale, key, vars),
      list: (key) => {
        const v = lookup(dictionaries[locale], key)
        return Array.isArray(v) ? (v as string[]) : []
      },
      formatDate: (iso) => dateFmt.format(new Date(iso)),
      formatNumber: (n) => numFmt.format(n),
    }
  }, [locale, setLocale])

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext)
  if (!ctx) throw new Error('useI18n must be used within I18nProvider')
  return ctx
}
