import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useI18n } from '../../i18n'
import { ApiError, apiFetch } from '../../lib/api'
import { Button } from '../../components/ui/Button'
import { Dialog } from '../../components/ui/Dialog'

type T = (k: string, v?: Record<string, string | number>) => string

/** GET con stato di caricamento/errore e ricarica. */
export function useApi<D>(path: string | null) {
  const [data, setData] = useState<D | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [loading, setLoading] = useState(Boolean(path))
  const load = useCallback(async () => {
    if (!path) return
    setLoading(true)
    setError(null)
    try {
      setData(await apiFetch<D>(path))
    } catch (err) {
      setError(err)
    } finally {
      setLoading(false)
    }
  }, [path])
  useEffect(() => {
    void load()
  }, [load])
  return { data, error, loading, reload: load, setData }
}

export const post = <R = unknown,>(path: string, body: Record<string, unknown>) => apiFetch<R>(path, { method: 'POST', body })

/** Messaggio per gli errori della console (codici stabili delle API). */
export function consoleError(err: unknown, t: T): string {
  if (err instanceof ApiError) {
    const d = err.details
    for (const ns of ['resellerPortal.errors', 'billing.errors']) {
      const k = `${ns}.${err.code}`
      const m = t(k, { limit: Number(d.limit ?? 0), used: Number(d.used ?? 0), remaining: Number(d.remaining ?? 0) })
      if (m !== k) return m
    }
    if (err.code === 'reason_required' || err.code === 'invalid_reason') return t('console.reason')
  }
  return t('resellerPortal.errors.generic')
}

export function useFormatters() {
  const { locale, formatNumber } = useI18n()
  const tag = locale === 'it' ? 'it-IT' : 'en-GB'
  const money = (cents: number | null | undefined, currency = 'eur') =>
    new Intl.NumberFormat(tag, { style: 'currency', currency: currency.toUpperCase(), maximumFractionDigits: 2 }).format((cents ?? 0) / 100)
  const usd = (n: number | null | undefined) => new Intl.NumberFormat(tag, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(n ?? 0)
  return { money, usd, num: (n: number | null | undefined) => formatNumber(n ?? 0) }
}

/** Conferma con motivazione obbligatoria (≥ 10 caratteri), registrata nell'audit dal server. */
export function ReasonDialog({
  open,
  title,
  body,
  danger,
  onClose,
  onConfirm,
}: {
  open: boolean
  title: string
  body?: ReactNode
  danger?: boolean
  onClose: () => void
  onConfirm: (reason: string) => Promise<void>
}) {
  const { t } = useI18n()
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (open) {
      setReason('')
      setError(null)
    }
  }, [open])
  const valid = reason.trim().length >= 10
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      closeLabel={t('console.close')}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t('console.cancel')}
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            disabled={!valid}
            loading={busy}
            onClick={async () => {
              setBusy(true)
              setError(null)
              try {
                await onConfirm(reason.trim())
                onClose()
              } catch (err) {
                setError(consoleError(err, t))
              } finally {
                setBusy(false)
              }
            }}
          >
            {t('console.confirm')}
          </Button>
        </div>
      }
    >
      {body && <div className="mb-3 text-sm">{body}</div>}
      <label className="block text-sm">
        <span className="font-medium">{t('console.reason')}</span>
        <textarea
          className="mt-1 w-full rounded-[var(--radius-control)] border border-line bg-surface p-2 text-sm"
          rows={3}
          maxLength={1000}
          value={reason}
          placeholder={t('console.reasonPlaceholder')}
          onChange={(e) => setReason(e.target.value)}
          data-autofocus
        />
      </label>
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
    </Dialog>
  )
}

export const inputCls = 'h-9 w-full rounded-[var(--radius-control)] border border-line bg-surface px-2 text-sm'

export function Table({ head, children, minWidth = 640 }: { head: ReactNode[]; children: ReactNode; minWidth?: number }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm" style={{ minWidth }}>
        <thead className="text-left text-xs text-muted">
          <tr>
            {head.map((h, i) => (
              <th key={i} className="py-2 pr-3 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">{children}</tbody>
      </table>
    </div>
  )
}
