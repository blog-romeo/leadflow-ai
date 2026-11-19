import { useCallback, useEffect, useState } from 'react'
import { Building2, ShieldAlert } from 'lucide-react'
import { useI18n } from '../../i18n'
import { supabase } from '../../lib/supabase'
import type { OrganizationRow } from '../../lib/database.types'
import { escapeLike, useDebounced } from '../../lib/useDebounced'
import { PageHeader } from '../../components/ui/PageHeader'
import { DataTable, type Column } from '../../components/ui/DataTable'
import { EmptyState } from '../../components/ui/States'
import { Badge } from '../../components/ui/Badge'
import { RequireSuperAdmin } from '../../routes/guards'

type OrgListRow = Pick<OrganizationRow, 'id' | 'name' | 'slug' | 'country' | 'created_at' | 'deleted_at'>
const PAGE_SIZE = 25

function OrganizationsTable() {
  const { t, formatDate } = useI18n()
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [rows, setRows] = useState<OrgListRow[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const q = useDebounced(search.trim(), 300)

  useEffect(() => setPage(1), [q])

  const load = useCallback(async () => {
    if (!supabase) return
    setLoading(true)
    setError(null)
    // La policy organizations_select concede la lettura completa solo ai super_admin.
    let query = supabase
      .from('organizations')
      .select('id, name, slug, country, created_at, deleted_at', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1)
    if (q) query = query.ilike('name', `%${escapeLike(q)}%`)
    const { data, count, error: err } = await query
    if (err) setError(t('errors.generic'))
    else {
      setRows((data ?? []) as OrgListRow[])
      setTotal(count ?? 0)
    }
    setLoading(false)
  }, [page, q, t])

  useEffect(() => {
    void load()
  }, [load])

  const columns: Column<OrgListRow>[] = [
    {
      key: 'name',
      header: t('admin.colOrg'),
      render: (r) => (
        <span className="flex items-center gap-2 font-medium">
          {r.name}
          {r.deleted_at && <Badge tone="danger">{t('admin.disabled')}</Badge>}
        </span>
      ),
    },
    { key: 'slug', header: t('admin.colSlug'), hideOnMobile: true, render: (r) => <span className="text-muted">{r.slug}</span> },
    { key: 'country', header: t('admin.colCountry'), render: (r) => r.country },
    { key: 'created', header: t('admin.colCreated'), hideOnMobile: true, render: (r) => <time dateTime={r.created_at}>{formatDate(r.created_at)}</time> },
  ]

  return (
    <DataTable
      caption={t('admin.title')}
      columns={columns}
      rows={rows}
      rowKey={(r) => r.id}
      loading={loading}
      error={error}
      onRetry={() => void load()}
      search={{ value: search, onChange: setSearch, placeholder: t('common.search') }}
      page={page}
      pageSize={PAGE_SIZE}
      total={total}
      onPageChange={setPage}
      empty={<EmptyState icon={Building2} title={t('admin.empty')} />}
    />
  )
}

export default function SuperAdmin() {
  const { t } = useI18n()
  return (
    <RequireSuperAdmin fallback={<EmptyState icon={ShieldAlert} title={t('admin.forbidden')} className="py-20" />}>
      <PageHeader title={t('admin.title')} subtitle={t('admin.subtitle')} />
      <OrganizationsTable />
    </RequireSuperAdmin>
  )
}
