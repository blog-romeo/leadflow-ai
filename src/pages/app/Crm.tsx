import { useCallback, useEffect, useState } from 'react'
import { Kanban } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { useI18n } from '../../i18n'
import { supabase } from '../../lib/supabase'
import { PIPELINE_STAGES, type ContactStatus, type LeadRow, type LeadStatus } from '../../lib/database.types'
import { escapeLike, useDebounced } from '../../lib/useDebounced'
import { PageHeader } from '../../components/ui/PageHeader'
import { DataTable, type Column } from '../../components/ui/DataTable'
import { Select } from '../../components/ui/Field'
import { Badge } from '../../components/ui/Badge'
import { EmptyState } from '../../components/ui/States'
import { Link } from 'react-router-dom'
import { CrmTabs } from '../../features/sales/CrmTabs'

type LeadListRow = Pick<LeadRow, 'id' | 'company_name' | 'city' | 'status' | 'contact_status' | 'score' | 'priority' | 'score_basis' | 'created_at'>
const STATUSES: LeadStatus[] = PIPELINE_STAGES
const PAGE_SIZE = 20

const contactTone: Record<ContactStatus, 'ok' | 'signal' | 'neutral'> = { active: 'ok', opted_out: 'signal', suppressed: 'neutral' }

export default function Crm() {
  const { t, formatDate } = useI18n()
  const { currentOrg } = useAuth()
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<LeadStatus | ''>('')
  const [page, setPage] = useState(1)
  const [rows, setRows] = useState<LeadListRow[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const q = useDebounced(search.trim(), 300)

  useEffect(() => setPage(1), [q, status])

  const load = useCallback(async () => {
    if (!supabase || !currentOrg) return
    setLoading(true)
    setError(null)
    let query = supabase
      .from('leads')
      .select('id, company_name, city, status, contact_status, score, priority, score_basis, created_at', { count: 'exact' })
      .eq('organization_id', currentOrg.id)
      .is('deleted_at', null)
      .order('score', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1)
    if (q) query = query.ilike('company_name', `%${escapeLike(q)}%`)
    if (status) query = query.eq('status', status)
    const { data, count, error: err } = await query
    if (err) setError(t('crm.loadError'))
    else {
      setRows((data ?? []) as LeadListRow[])
      setTotal(count ?? 0)
    }
    setLoading(false)
  }, [currentOrg, page, q, status, t])

  useEffect(() => {
    void load()
  }, [load])

  const columns: Column<LeadListRow>[] = [
    {
      key: 'company',
      header: t('crm.colCompany'),
      render: (r) => (
        <div>
          <Link to={`/app/sales-agent/leads/${r.id}`} className="font-medium hover:text-flow hover:underline">
            {r.company_name}
          </Link>
          {r.city && <p className="text-xs text-muted">{r.city}</p>}
        </div>
      ),
    },
    { key: 'status', header: t('crm.colStatus'), render: (r) => <Badge tone="flow">{t(`status.${r.status}`)}</Badge> },
    { key: 'contact', header: t('crm.colContact'), hideOnMobile: true, render: (r) => <Badge tone={contactTone[r.contact_status]}>{t(`status.${r.contact_status}`)}</Badge> },
    {
      key: 'score',
      header: t('crm.colScore'),
      align: 'right',
      hideOnMobile: true,
      render: (r) =>
        r.score === null ? (
          <span className="text-muted">{t('crm.noScore')}</span>
        ) : (
          <span className="inline-flex items-center gap-2">
            {r.priority && <Badge tone={r.priority === 'high' ? 'ok' : r.priority === 'medium' ? 'signal' : 'neutral'}>{t(`leadFinder.priority.${r.priority}`)}</Badge>}
            <span className="tabular font-semibold">{r.score}</span>
          </span>
        ),
    },
    { key: 'created', header: t('crm.colCreated'), hideOnMobile: true, render: (r) => <time dateTime={r.created_at}>{formatDate(r.created_at)}</time> },
  ]

  const filtered = !!q || !!status

  return (
    <>
      <PageHeader title={t('crm.title')} subtitle={t('crm.subtitle')} actions={<CrmTabs />} />
      <DataTable
        caption={t('crm.title')}
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        loading={loading}
        error={error}
        onRetry={() => void load()}
        search={{ value: search, onChange: setSearch, placeholder: t('crm.searchPlaceholder') }}
        filters={
          <Select label={t('crm.filterStatus')} hideLabel value={status} onChange={(e) => setStatus(e.target.value as LeadStatus | '')} className="min-w-40">
            <option value="">
              {t('crm.filterStatus')}: {t('common.all')}
            </option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`status.${s}`)}
              </option>
            ))}
          </Select>
        }
        page={page}
        pageSize={PAGE_SIZE}
        total={total}
        onPageChange={setPage}
        empty={
          filtered ? (
            <EmptyState icon={Kanban} title={t('crm.emptyFiltered')} />
          ) : (
            <EmptyState icon={Kanban} title={t('crm.emptyTitle')} body={t('crm.emptyBody')} />
          )
        }
      />
    </>
  )
}
