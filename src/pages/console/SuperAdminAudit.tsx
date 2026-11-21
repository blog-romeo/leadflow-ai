import { useState } from 'react'
import { useI18n } from '../../i18n'
import { useDebounced } from '../../lib/useDebounced'
import { PageHeader } from '../../components/ui/PageHeader'
import { Button } from '../../components/ui/Button'
import { ErrorState, LoadingState } from '../../components/ui/States'
import { Table, inputCls, useApi } from '../../features/console/shared'

interface Row { id: number; actor_role: string; action: string; target_type: string | null; target_id: string | null; reason: string | null; created_at: string }

export default function SuperAdminAudit() {
  const { t, formatDate } = useI18n()
  const [action, setAction] = useState('')
  const [page, setPage] = useState(1)
  const a = useDebounced(action.trim(), 300)
  const { data, error, loading, reload } = useApi<{ rows: Row[]; total: number }>(`/api/super-admin/audit?page=${page}${a.length >= 2 ? `&action=${encodeURIComponent(a)}` : ''}`)
  const pages = Math.max(1, Math.ceil((data?.total ?? 0) / 50))
  return (
    <>
      <PageHeader title={t('saAudit.title')} />
      <input className={`${inputCls} mb-4 max-w-sm`} value={action} placeholder={t('saAudit.filter')} onChange={(e) => { setAction(e.target.value); setPage(1) }} aria-label={t('saAudit.filter')} />
      {loading && !data ? <LoadingState /> : error || !data ? <ErrorState message={t('console.loadError')} onRetry={() => void reload()} /> : (
        <>
          <Table minWidth={760} head={[t('saAudit.colWhen'), t('saAudit.colActor'), t('saAudit.colAction'), t('saAudit.colTarget'), t('saAudit.colReason')]}>
            {data.rows.map((r) => (
              <tr key={r.id}>
                <td className="whitespace-nowrap py-2 pr-3">{formatDate(r.created_at)} {new Date(r.created_at).toLocaleTimeString()}</td>
                <td className="py-2 pr-3 text-xs">{r.actor_role}</td>
                <td className="py-2 pr-3 font-mono text-xs">{r.action}</td>
                <td className="py-2 pr-3 text-xs">{r.target_type ?? '—'} <span className="font-mono text-muted">{r.target_id?.slice(0, 8)}</span></td>
                <td className="max-w-[320px] py-2 text-xs">{r.reason ?? ''}</td>
              </tr>
            ))}
          </Table>
          <div className="mt-3 flex items-center justify-end gap-2 text-sm">
            <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>‹</Button>
            <span className="tabular">{page}/{pages}</span>
            <Button size="sm" variant="ghost" disabled={page >= pages} onClick={() => setPage(page + 1)}>›</Button>
          </div>
        </>
      )}
    </>
  )
}
