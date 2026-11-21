import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Check, LayoutDashboard, Radar, Sparkles, Compass } from 'lucide-react'
import { useI18n } from '../i18n'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import { apiFetch, ApiError } from '../lib/api'
import { normalizeVat, validateOrganizationName, validateVatNumber } from '../lib/validation'
import { errorKey } from '../lib/errors'
import { useNoIndex } from '../lib/seo'
import { pendingInvite } from '../lib/pendingInvite'
import { COUNTRIES } from '../config/countries'
import { PLANS, SIGNUP_PLAN_KEY, type PlanCode } from '../config/plans'
import type { OnboardingProgressRow } from '../lib/database.types'
import { Logo } from '../components/ui/Logo'
import { Field, Select } from '../components/ui/Field'
import { Button, buttonClasses } from '../components/ui/Button'
import { InlineAlert, LoadingState } from '../components/ui/States'
import { LanguageSwitch, ThemeToggle } from '../components/ui/Preferences'
import { PricingCards } from '../components/public/PricingCards'
import { cn } from '../lib/cn'
import { env } from '../lib/env'

const STEPS = ['account', 'company', 'commercial', 'plan', 'payment', 'setup'] as const
const SIZES = ['1-9', '10-49', '50-249', '250+'] as const

const textareaCls =
  'w-full rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-muted/80 focus:border-flow focus:outline-none focus:ring-2 focus:ring-flow/25'

function Stepper({ step }: { step: number }) {
  const { t } = useI18n()
  return (
    <ol className="flex flex-wrap gap-x-4 gap-y-2 text-sm" aria-label={t('wizard.stepOf', { n: step, total: STEPS.length })}>
      {STEPS.map((s, i) => {
        const n = i + 1
        const done = n < step
        const current = n === step
        return (
          <li key={s} className={cn('flex items-center gap-2', current ? 'font-semibold text-ink' : done ? 'text-ok' : 'text-muted')} aria-current={current ? 'step' : undefined}>
            <span className={cn('grid size-6 place-items-center rounded-full border text-xs tabular', current ? 'border-flow bg-flow text-white' : done ? 'border-ok' : 'border-line')}>
              {done ? <Check className="size-3.5" aria-hidden /> : n}
            </span>
            <span className="hidden sm:inline">{t(`wizard.steps.${s}`)}</span>
          </li>
        )
      })}
    </ol>
  )
}

function Frame({ step, children, title, intro }: { step: number; children: ReactNode; title: string; intro?: string }) {
  const { t } = useI18n()
  const { user, signOut } = useAuth()
  return (
    <div className="min-h-dvh bg-bg">
      <header className="mx-auto flex h-16 max-w-4xl items-center gap-3 px-4 sm:px-6">
        <Logo />
        <div className="ml-auto flex items-center gap-2">
          <LanguageSwitch />
          <ThemeToggle />
        </div>
      </header>
      <main id="main" className="mx-auto max-w-4xl px-4 pb-16 sm:px-6">
        <p className="text-sm text-muted">{t('wizard.stepOf', { n: step, total: STEPS.length })}</p>
        <div className="mt-3">
          <Stepper step={step} />
        </div>
        <h1 className="mt-8 text-3xl font-semibold">{title}</h1>
        {intro && <p className="mt-2 max-w-[65ch] text-muted">{intro}</p>}
        <div className="mt-6">{children}</div>
        <p className="mt-12 flex flex-wrap items-center gap-x-2 text-sm text-muted">
          {t('onboarding.signedInAs', { email: user?.email ?? '' })}
          <button type="button" onClick={() => void signOut()} className="font-medium text-flow hover:underline">
            {t('common.signOut')}
          </button>
        </p>
      </main>
    </div>
  )
}

function rpcErr(err: { message?: string } | null, t: (k: string) => string): string {
  const code = err?.message ?? ''
  const k = `wizard.errors.${code}`
  const m = t(k)
  return m === k ? t('wizard.errors.generic') : m
}

export default function Onboarding() {
  const { t } = useI18n()
  useNoIndex(t('wizard.title'))
  const { currentOrg, isOrgAdmin, refresh, setCurrentOrgId } = useAuth()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const [state, setState] = useState<OnboardingProgressRow | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [resumed, setResumed] = useState(false)

  // Invitato da un'organizzazione: si accetta l'invito invece di crearne una nuova.
  useEffect(() => {
    if (!currentOrg && pendingInvite()) navigate('/join', { replace: true })
  }, [currentOrg, navigate])

  const load = useCallback(async () => {
    if (!supabase) return setLoadError(t('errors.notConfigured'))
    const { data, error: err } = await supabase.rpc('onboarding_state')
    if (err) return setLoadError(t('wizard.errors.generic'))
    const s = data as unknown as OnboardingProgressRow
    setState(s)
    if (s.step > 2 && !s.completed_at) setResumed(true)
  }, [t])
  useEffect(() => {
    void load()
  }, [load])

  const orgId = state?.organization_id ?? currentOrg?.id ?? null
  const step = state ? (state.completed_at ? 6 : Math.max(2, state.step)) : 2

  if (loadError) return <Frame step={2} title={t('wizard.title')}><InlineAlert>{loadError}</InlineAlert></Frame>
  if (!state) return <LoadingState className="min-h-dvh" />

  const run = async (fn: () => Promise<{ data: unknown; error: { message?: string } | null }>) => {
    setBusy(true)
    setError(null)
    const { data, error: err } = await fn()
    setBusy(false)
    if (err) {
      setError(rpcErr(err, t))
      return false
    }
    setState(data as OnboardingProgressRow)
    return true
  }

  const banner = resumed && <p className="mb-4 rounded-md bg-flow-soft px-3 py-2 text-sm text-flow">{t('wizard.resumed')}</p>
  const errBox = error && <div className="mb-4"><InlineAlert>{error}</InlineAlert></div>
  const goBack = (to: number) => setState((s) => (s ? { ...s, step: to } : s))

  if (step === 2)
    return (
      <Frame step={2} title={t('wizard.company.title')}>
        {banner}
        {errBox}
        <CompanyStep
          orgId={orgId}
          orgName={currentOrg?.name ?? null}
          initial={state.company}
          busy={busy}
          onSubmit={async (v) => {
            if (!supabase) return
            let id = orgId
            if (!id) {
              setBusy(true)
              const { data, error: err } = await supabase.rpc('create_organization', { p_name: v.name.trim(), p_vat_number: normalizeVat(v.vat), p_country: v.country })
              setBusy(false)
              if (err || !data) return setError(t(errorKey(err)))
              const created: string = data.id
              id = created
              setCurrentOrgId(created)
              await refresh()
            }
            const orgFinal: string = id
            await run(async () => supabase!.rpc('onboarding_save_company', { p_org: orgFinal, p_sector: v.sector || null, p_website: v.website || null, p_size: v.size || null }))
          }}
        />
      </Frame>
    )

  if (step === 3)
    return (
      <Frame step={3} title={t('wizard.commercial.title')} intro={t('wizard.commercial.intro')}>
        {banner}
        {errBox}
        <CommercialStep
          initial={state.commercial}
          busy={busy}
          onBack={() => goBack(2)}
          onSubmit={(v) => run(async () => supabase!.rpc('onboarding_save_commercial', { p_org: orgId!, p_services: v.services || null, p_ideal_customer: v.ideal_customer || null, p_area: v.area || null, p_goal: v.goal || null }))}
        />
      </Frame>
    )

  if (step === 4) {
    const stored = (() => {
      try {
        return localStorage.getItem(SIGNUP_PLAN_KEY)
      } catch {
        return null
      }
    })()
    const preselected = (state.plan_code ?? (PLANS.some((p) => p.code === stored) ? stored : null)) as PlanCode | null
    return (
      <Frame step={4} title={t('wizard.plan.title')} intro={env.featureFreeBeta ? t('wizard.plan.betaIntro') : t('wizard.plan.intro')}>
        {banner}
        {errBox}
        {env.featureFreeBeta && (
          <div className="mb-8 rounded-[var(--radius-panel)] border border-flow/40 bg-flow-soft p-5">
            <h2 className="text-lg font-semibold">{t('wizard.plan.betaTitle')}</h2>
            <p className="mt-1 text-sm text-muted">{t('wizard.plan.betaBody')}</p>
            <Button
              className="mt-4"
              loading={busy}
              onClick={() =>
                void run(async () => {
                  // Avanza solo se il database ha davvero concesso l'accesso beta (free_beta_enabled).
                  const r = await supabase!.rpc('onboarding_advance', { p_action: 'payment_confirmed' })
                  return r.error ? { data: null, error: { message: r.error.message?.includes('payment_not_confirmed') ? 'beta_unavailable' : r.error.message } } : r
                })
              }
            >
              {t('wizard.plan.betaCta')}
            </Button>
          </div>
        )}
        <PricingCards compact selected={preselected} onChoose={(code) => void run(async () => supabase!.rpc('onboarding_advance', { p_action: 'choose_plan', p_plan: code }))} />
        <Button variant="ghost" className="mt-6" onClick={() => goBack(3)}>
          {t('wizard.back')}
        </Button>
      </Frame>
    )
  }

  if (step === 5)
    return (
      <Frame step={5} title={t('wizard.payment.title')} intro={t('wizard.payment.intro')}>
        {errBox}
        <PaymentStep
          orgId={orgId!}
          plan={(state.plan_code ?? 'starter') as PlanCode}
          isAdmin={isOrgAdmin}
          checkout={params.get('checkout')}
          clearCheckout={() => setParams({}, { replace: true })}
          onState={(s) => setState(s)}
          onBack={() => goBack(4)}
        />
      </Frame>
    )

  return (
    <Frame step={6} title={t('wizard.setup.title')} intro={t('wizard.setup.intro')}>
      {errBox}
      <ul className="grid gap-3 sm:grid-cols-2">
        {[
          { to: '/app', icon: LayoutDashboard, k: 'dashboard' },
          { to: '/app?tour=1', icon: Compass, k: 'tour' },
          { to: '/app/lead-finder', icon: Radar, k: 'search' },
          { to: '/app/sales-agent/profile', icon: Sparkles, k: 'ai' },
        ].map(({ to, icon: Icon, k }) => (
          <li key={k}>
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                if (!state.completed_at && supabase) await run(async () => supabase!.rpc('onboarding_advance', { p_action: 'complete' }))
                navigate(to)
              }}
              className="flex w-full items-start gap-3 rounded-[var(--radius-panel)] border border-line bg-surface p-4 text-left hover:border-flow"
            >
              <Icon className="mt-0.5 size-5 shrink-0 text-flow" aria-hidden />
              <span>
                <span className="block font-semibold">{t(`wizard.setup.${k}`)}</span>
                <span className="block text-sm text-muted">{t(`wizard.setup.${k}Body`)}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      <Button
        size="lg"
        className="mt-8"
        loading={busy}
        onClick={async () => {
          if (!state.completed_at && supabase) await run(async () => supabase!.rpc('onboarding_advance', { p_action: 'complete' }))
          navigate('/app', { replace: true })
        }}
      >
        {t('wizard.setup.finish')}
      </Button>
    </Frame>
  )
}

function CompanyStep({
  orgId,
  orgName,
  initial,
  busy,
  onSubmit,
}: {
  orgId: string | null
  orgName: string | null
  initial: OnboardingProgressRow['company']
  busy: boolean
  onSubmit: (v: { name: string; vat: string; country: string; sector: string; website: string; size: string }) => Promise<void>
}) {
  const { t, locale } = useI18n()
  const [v, setV] = useState({ name: orgName ?? '', vat: '', country: 'IT', sector: initial.sector ?? '', website: initial.website ?? '', size: initial.size ?? '' })
  const [errors, setErrors] = useState<{ name?: string | null; vat?: string | null; sector?: string | null; size?: string | null }>({})
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV((s) => ({ ...s, [k]: e.target.value }))
  async function submit(e: FormEvent) {
    e.preventDefault()
    const n = orgId ? { ok: true as const } : validateOrganizationName(v.name)
    const vat = orgId ? { ok: true as const } : validateVatNumber(v.vat)
    const next = {
      name: n.ok ? null : t(n.error),
      vat: vat.ok ? null : t(vat.error),
      sector: v.sector.trim().length >= 2 ? null : t('demo.errors.required'),
      size: v.size ? null : t('wizard.errors.invalid_size'),
    }
    setErrors(next)
    if (Object.values(next).some(Boolean)) return
    await onSubmit(v)
  }
  return (
    <form onSubmit={submit} noValidate className="grid max-w-2xl gap-4 sm:grid-cols-2">
      {orgId ? (
        <p className="text-sm text-muted sm:col-span-2">
          <strong className="text-ink">{orgName}</strong> — {t('wizard.company.existing')}
        </p>
      ) : (
        <>
          <Field label={t('wizard.company.legalName')} autoComplete="organization" value={v.name} onChange={set('name')} error={errors.name} maxLength={120} required className="sm:col-span-2" />
          <Field label={t('wizard.company.vat')} value={v.vat} onChange={set('vat')} hint={t('onboarding.vatHint')} error={errors.vat} maxLength={20} />
          <Select label={t('wizard.company.country')} value={v.country} onChange={set('country')}>
            {COUNTRIES.map((c) => (
              <option key={c.code} value={c.code}>{c.name[locale]}</option>
            ))}
          </Select>
        </>
      )}
      <Field label={t('wizard.company.sector')} placeholder={t('wizard.company.sectorPlaceholder')} value={v.sector} onChange={set('sector')} error={errors.sector} maxLength={160} required />
      <Field label={t('wizard.company.website')} type="url" inputMode="url" placeholder="https://" value={v.website} onChange={set('website')} maxLength={300} />
      <Select label={t('wizard.company.size')} value={v.size} onChange={set('size')} aria-invalid={!!errors.size || undefined}>
        <option value="">—</option>
        {SIZES.map((s) => (
          <option key={s} value={s}>{t(`wizard.company.sizes.${s}`)}</option>
        ))}
      </Select>
      {errors.size && <p role="alert" className="text-xs font-medium text-danger sm:col-span-2">{errors.size}</p>}
      <div className="sm:col-span-2">
        <Button type="submit" size="lg" loading={busy}>
          {t('wizard.next')}
        </Button>
      </div>
    </form>
  )
}

function CommercialStep({
  initial,
  busy,
  onBack,
  onSubmit,
}: {
  initial: OnboardingProgressRow['commercial']
  busy: boolean
  onBack: () => void
  onSubmit: (v: { services: string; ideal_customer: string; area: string; goal: string }) => Promise<boolean>
}) {
  const { t } = useI18n()
  const [v, setV] = useState({ services: initial.services ?? '', ideal_customer: initial.ideal_customer ?? '', area: initial.area ?? '', goal: initial.goal ?? '' })
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV((s) => ({ ...s, [k]: e.target.value }))
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        void onSubmit(v)
      }}
      className="max-w-2xl space-y-4"
    >
      <div className="space-y-1.5">
        <label htmlFor="ob-services" className="block text-sm font-medium">{t('wizard.commercial.services')}</label>
        <textarea id="ob-services" rows={3} value={v.services} onChange={set('services')} maxLength={4000} className={textareaCls} />
      </div>
      <div className="space-y-1.5">
        <label htmlFor="ob-ideal" className="block text-sm font-medium">{t('wizard.commercial.idealCustomer')}</label>
        <textarea id="ob-ideal" rows={3} value={v.ideal_customer} onChange={set('ideal_customer')} placeholder={t('wizard.commercial.idealPlaceholder')} maxLength={4000} className={textareaCls} />
      </div>
      <Field label={t('wizard.commercial.area')} hint={t('wizard.commercial.areaHint')} value={v.area} onChange={set('area')} maxLength={600} />
      <Field label={t('wizard.commercial.goal')} placeholder={t('wizard.commercial.goalPlaceholder')} value={v.goal} onChange={set('goal')} maxLength={600} />
      <div className="flex gap-3">
        <Button variant="ghost" onClick={onBack}>
          {t('wizard.back')}
        </Button>
        <Button type="submit" size="lg" loading={busy}>
          {t('wizard.next')}
        </Button>
      </div>
    </form>
  )
}

function PaymentStep({
  orgId,
  plan,
  isAdmin,
  checkout,
  clearCheckout,
  onState,
  onBack,
}: {
  orgId: string
  plan: PlanCode
  isAdmin: boolean
  checkout: string | null
  clearCheckout: () => void
  onState: (s: OnboardingProgressRow) => void
  onBack: () => void
}) {
  const { t } = useI18n()
  const [phase, setPhase] = useState<'idle' | 'redirecting' | 'waiting' | 'not_yet' | 'cancelled'>(checkout === 'success' ? 'waiting' : checkout === 'cancelled' ? 'cancelled' : 'idle')
  const [error, setError] = useState<string | null>(null)
  const tries = useRef(0)
  const [mode, setMode] = useState<string | null>(null)
  useEffect(() => {
    apiFetch<{ stripe?: { mode?: string } }>(`/api/billing/status?organization_id=${orgId}`)
      .then((r) => setMode(r.stripe?.mode ?? null))
      .catch(() => setMode(null))
  }, [orgId])
  const planName = PLANS.find((p) => p.code === plan)?.name ?? plan

  const tryConfirm = useCallback(async (): Promise<boolean> => {
    if (!supabase) return false
    const { data, error: err } = await supabase.rpc('onboarding_advance', { p_action: 'payment_confirmed' })
    if (err) return false
    onState(data as unknown as OnboardingProgressRow)
    return true
  }, [onState])

  // Abbonamento già attivo (es. pagato da un altro dispositivo): si passa oltre.
  useEffect(() => {
    if (checkout !== 'success') void tryConfirm()
  }, [checkout, tryConfirm])

  // Ritorno da Stripe: si attende il webhook, MAI attivazione basata sul solo redirect.
  useEffect(() => {
    if (phase !== 'waiting') return
    let stop = false
    const tick = async () => {
      if (stop) return
      if (await tryConfirm()) {
        clearCheckout()
        return
      }
      tries.current += 1
      if (tries.current >= 20) {
        setPhase('not_yet')
        return
      }
      setTimeout(() => void tick(), 3000)
    }
    void tick()
    return () => {
      stop = true
    }
  }, [phase, tryConfirm, clearCheckout])

  async function pay() {
    setError(null)
    setPhase('redirecting')
    try {
      const r = await apiFetch<{ url: string }>('/api/billing/checkout', { method: 'POST', body: { organization_id: orgId, plan, return_to: 'onboarding' } })
      if (!r.url.startsWith('https://checkout.stripe.com/')) throw new ApiError(502, 'stripe_unavailable')
      window.location.assign(r.url)
    } catch (err) {
      setPhase('idle')
      const code = err instanceof ApiError ? err.code : 'generic'
      const k = `billing.errors.${code}`
      const m = t(k)
      setError(m === k ? t('wizard.errors.generic') : m)
    }
  }

  async function later() {
    if (!supabase) return
    const { data, error: err } = await supabase.rpc('onboarding_advance', { p_action: 'defer_payment' })
    if (err) return setError(t('wizard.errors.generic'))
    clearCheckout()
    onState(data as unknown as OnboardingProgressRow)
  }

  return (
    <div className="max-w-2xl space-y-4">
      {error && <InlineAlert>{error}</InlineAlert>}
      <div className="rounded-[var(--radius-panel)] border border-line bg-surface p-5">
        <p className="font-semibold">{planName}</p>
        {phase === 'waiting' && <p className="mt-2 text-sm text-muted" role="status">{t('wizard.payment.waiting')}</p>}
        {phase === 'not_yet' && <p className="mt-2 text-sm text-signal" role="status">{t('wizard.payment.notYet')}</p>}
        {phase === 'cancelled' && <p className="mt-2 text-sm text-signal" role="status">{t('wizard.payment.cancelled')}</p>}
        {!isAdmin && <p className="mt-2 text-sm text-muted">{t('wizard.payment.adminOnly')}</p>}
        {mode === 'test' && <p className="mt-3 text-xs text-muted">{t('wizard.payment.testMode')}</p>}
      </div>
      <div className="flex flex-wrap gap-3">
        <Button variant="ghost" onClick={onBack} disabled={phase === 'waiting' || phase === 'redirecting'}>
          {t('wizard.back')}
        </Button>
        {isAdmin && phase !== 'waiting' && (
          <Button size="lg" loading={phase === 'redirecting'} onClick={() => void pay()}>
            {t('wizard.payment.pay')}
          </Button>
        )}
        <Button variant="secondary" size="lg" onClick={() => void later()} disabled={phase === 'redirecting'}>
          {t('wizard.payment.later')}
        </Button>
      </div>
      <p className="text-sm text-muted">{t('wizard.payment.laterNote')}</p>
      <Link to="/prezzi" target="_blank" className={buttonClasses('ghost', 'sm')}>
        {t('pricing.conditionsTitle')}
      </Link>
    </div>
  )
}
