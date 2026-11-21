import { useCallback, useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Check, CircleDashed } from 'lucide-react'
import { useI18n } from '../../i18n'
import { supabase } from '../../lib/supabase'
import { buttonClasses, Button } from '../../components/ui/Button'
import { Dialog } from '../../components/ui/Dialog'
import { LoadingState } from '../../components/ui/States'
import type { OnboardingProgressRow } from '../../lib/database.types'
import { cn } from '../../lib/cn'

export interface Checklist {
  profile_completed: boolean
  first_search: boolean
  first_lead_saved: boolean
  first_ai_analysis: boolean
  has_access: boolean
}

/** Stato dell'onboarding e checklist calcolata dal database (dati reali, non stime). */
export function useOnboarding(orgId: string | undefined) {
  const [state, setState] = useState<OnboardingProgressRow | null>(null)
  const [checklist, setChecklist] = useState<Checklist | null>(null)
  const load = useCallback(async () => {
    if (!supabase || !orgId) return
    const [s, c] = await Promise.all([supabase.rpc('onboarding_state'), supabase.rpc('onboarding_checklist', { p_org: orgId })])
    if (!s.error) setState(s.data as unknown as OnboardingProgressRow)
    if (!c.error) setChecklist(c.data as unknown as Checklist)
  }, [orgId])
  useEffect(() => {
    void load()
  }, [load])
  return { state, checklist, reload: load }
}

export function SetupBanner({ state, checklist }: { state: OnboardingProgressRow | null; checklist: Checklist | null }) {
  const { t } = useI18n()
  if (!state || !checklist) return null
  const incomplete = !state.completed_at
  const unpaid = !checklist.has_access
  if (!incomplete && !unpaid) return null
  return (
    <div className="flex flex-col gap-3 rounded-[var(--radius-panel)] border border-flow/40 bg-flow-soft px-5 py-4 sm:flex-row sm:items-center">
      <p className="flex-1 text-sm text-ink">{incomplete ? t('getStarted.resume') : t('getStarted.payNow')}</p>
      <Link to={incomplete ? '/onboarding' : '/app/billing'} className={buttonClasses('primary', 'sm')}>
        {incomplete ? t('getStarted.resumeCta') : t('getStarted.payCta')}
      </Link>
    </div>
  )
}

const ITEMS: { key: keyof Omit<Checklist, 'has_access'>; to: string }[] = [
  { key: 'profile_completed', to: '/onboarding' },
  { key: 'first_search', to: '/app/lead-finder' },
  { key: 'first_lead_saved', to: '/app/lead-finder' },
  { key: 'first_ai_analysis', to: '/app/lead-finder' },
]

export function GettingStartedList({ checklist }: { checklist: Checklist | null }) {
  const { t } = useI18n()
  if (!checklist) return <LoadingState />
  const done = ITEMS.filter((i) => checklist[i.key]).length
  return (
    <div>
      <p className="mb-3 text-xs text-muted">{t('getStarted.progress', { done, total: ITEMS.length })}</p>
      <ol className="space-y-3">
        {ITEMS.map((i) => {
          const ok = checklist[i.key]
          return (
            <li key={i.key} className="flex items-start gap-3 text-sm">
              {ok ? (
                <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-flow text-flow-ink">
                  <Check className="size-3" aria-hidden />
                </span>
              ) : (
                <CircleDashed className="mt-0.5 size-5 shrink-0 text-muted" aria-hidden />
              )}
              {ok ? (
                <span className={cn('text-muted line-through decoration-line')}>{t(`getStarted.items.${i.key}`)}</span>
              ) : (
                <Link to={i.to} className="text-flow hover:underline">
                  {t(`getStarted.items.${i.key}`)}
                </Link>
              )}
            </li>
          )
        })}
      </ol>
    </div>
  )
}

/** Guida rapida in 4 schermate, aperta con ?tour=1 (dall'onboarding). */
export function Tour({ onDone }: { onDone?: () => void }) {
  const { t } = useI18n()
  const [params, setParams] = useSearchParams()
  const open = params.get('tour') === '1'
  const [i, setI] = useState(0)
  const steps = ['s1', 's2', 's3', 's4'] as const
  const close = async () => {
    setParams({}, { replace: true })
    setI(0)
    if (supabase) await supabase.rpc('onboarding_advance', { p_action: 'tour_done' })
    onDone?.()
  }
  const s = steps[i]!
  return (
    <Dialog
      open={open}
      onClose={() => void close()}
      title={t(`tour.${s}Title`)}
      closeLabel={t('tour.skip')}
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          <span className="text-xs text-muted tabular">
            {i + 1} / {steps.length}
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => void close()}>
              {t('tour.skip')}
            </Button>
            {i < steps.length - 1 ? (
              <Button size="sm" onClick={() => setI(i + 1)}>
                {t('tour.next')}
              </Button>
            ) : (
              <Button size="sm" onClick={() => void close()}>
                {t('tour.done')}
              </Button>
            )}
          </div>
        </div>
      }
    >
      <p className="text-sm text-muted">{t(`tour.${s}Body`)}</p>
    </Dialog>
  )
}
