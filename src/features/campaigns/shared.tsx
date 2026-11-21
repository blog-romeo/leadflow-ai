import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useI18n } from '../../i18n'
import { supabase } from '../../lib/supabase'
import { ApiError } from '../../lib/api'
import { Badge } from '../../components/ui/Badge'
import { cn } from '../../lib/cn'
import type { CommunicationAccountRow, WorkflowStatus } from '../../lib/database.types'
import { billingErrorMessage } from '../billing/errors'

type T = (k: string, v?: Record<string, string | number>) => string

export type Period = 'd7' | 'd30' | 'd90' | 'd365'
export const PERIOD_DAYS: Record<Period, number> = { d7: 7, d30: 30, d90: 90, d365: 365 }
export function periodRange(p: Period) {
  const to = new Date(Date.now() + 60_000)
  return { from: new Date(to.getTime() - PERIOD_DAYS[p] * 86_400_000).toISOString(), to: to.toISOString() }
}

const STATUS_TONE: Record<WorkflowStatus, 'neutral' | 'flow' | 'signal' | 'danger' | 'ok'> = {
  draft: 'neutral',
  pending_approval: 'signal',
  scheduled: 'flow',
  running: 'ok',
  paused: 'signal',
  completed: 'neutral',
  failed: 'danger',
  cancelled: 'neutral',
}
export function CampaignStatusBadge({ status }: { status: WorkflowStatus }) {
  const { t } = useI18n()
  return <Badge tone={STATUS_TONE[status]}>{t(`cm.status.${status}`)}</Badge>
}

export function Kpi({ label, value, hint, sub }: { label: string; value: ReactNode; hint?: string; sub?: ReactNode }) {
  return (
    <div className="min-w-0 rounded-[var(--radius-panel)] border border-line bg-surface px-4 py-3.5" title={hint}>
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 font-display text-2xl font-semibold tabular">{value}</p>
      {sub && <div className="mt-0.5 text-xs text-muted">{sub}</div>}
    </div>
  )
}

export function CheckBadge({ value }: { value: 'pass' | 'missing' | 'fail' | 'unknown' }) {
  const { t } = useI18n()
  return <Badge tone={value === 'pass' ? 'ok' : value === 'fail' ? 'danger' : value === 'missing' ? 'signal' : 'neutral'}>{t(`channels.checkStatus.${value}`)}</Badge>
}

/** Account di invio dell'organizzazione (lettura con RLS; nessuna credenziale). */
export function useAccounts(orgId: string) {
  const [accounts, setAccounts] = useState<CommunicationAccountRow[] | null>(null)
  const reload = useCallback(async () => {
    if (!supabase || !orgId) return
    const { data } = await supabase.from('communication_accounts').select('*').eq('organization_id', orgId).neq('status', 'revoked').order('created_at', { ascending: false })
    setAccounts((data ?? []) as CommunicationAccountRow[])
  }, [orgId])
  useEffect(() => {
    void reload()
  }, [reload])
  const connected = (accounts ?? []).filter((a) => a.status === 'connected')
  return { accounts, connected, reload }
}

/** Messaggio leggibile per errori del database (RPC con prefisso "codice:") o delle API. */
export function cmError(err: unknown, t: T): string {
  const billing = billingErrorMessage(err, t)
  if (billing) return billing
  if (err instanceof ApiError) {
    for (const ns of ['channels.errors', 'cm.errors', 'sales.errors']) {
      const k = `${ns}.${err.code}`
      const m = t(k)
      if (m !== k) return m
    }
    return t('channels.errors.generic')
  }
  const e = err as { message?: string; code?: string } | null
  const msg = e?.message ?? ''
  const code = msg.split(':')[0]?.trim() ?? ''
  const k = `cm.errors.${code}`
  const m = t(k)
  if (m !== k) return m
  if (e?.code === '42501' || /permission denied|row-level security|only organization admins/i.test(msg)) return t('cm.errors.forbidden')
  return t('cm.errors.generic')
}

export function ReasonList({ codes, ns = 'cm.reasons', className }: { codes: string[]; ns?: string; className?: string }) {
  const { t } = useI18n()
  if (!codes.length) return null
  return (
    <ul className={cn('space-y-0.5', className)}>
      {codes.map((c) => {
        const k = `${ns}.${c}`
        const m = t(k)
        return <li key={c}>{m === k ? c : m}</li>
      })}
    </ul>
  )
}

export const splitList = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)

export function TextArea({ id, label, value, onChange, disabled, hint, rows = 4, maxLength = 6000 }: { id: string; label: string; value: string; onChange: (v: string) => void; disabled?: boolean; hint?: string; rows?: number; maxLength?: number }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      <textarea
        id={id}
        rows={rows}
        value={value}
        disabled={disabled}
        maxLength={maxLength}
        onChange={(e) => onChange(e.target.value)}
        aria-describedby={hint ? `${id}-hint` : undefined}
        className="w-full rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-sm focus:border-flow focus:ring-2 focus:ring-flow/25 focus:outline-none disabled:opacity-60"
      />
      {hint && (
        <p id={`${id}-hint`} className="text-xs text-muted">
          {hint}
        </p>
      )}
    </div>
  )
}

export function Check({ id, label, checked, onChange, disabled }: { id: string; label: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label htmlFor={id} className="flex items-start gap-2 text-sm">
      <input id={id} type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 size-4 accent-[var(--color-flow)]" />
      <span>{label}</span>
    </label>
  )
}
