import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Ban, Download, FileUp, UserPlus } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { useI18n } from '../../i18n'
import { supabase } from '../../lib/supabase'
import { apiErrorMessage, apiFetch } from '../../lib/api'
import { escapeLike, useDebounced } from '../../lib/useDebounced'
import { PageHeader } from '../../components/ui/PageHeader'
import { Button } from '../../components/ui/Button'
import { ErrorState, InlineAlert, LoadingState } from '../../components/ui/States'
import { ProviderStatus, NoProviderNotice } from '../../features/lead-finder/ProviderStatus'
import { UsageMeter } from '../../features/lead-finder/UsageMeter'
import { SearchForm, type SearchFormValues } from '../../features/lead-finder/SearchForm'
import { SearchProgress, STAGES, type Stage } from '../../features/lead-finder/SearchProgress'
import { CandidatesTable, type TableFilters } from '../../features/lead-finder/CandidatesTable'
import { CandidateDetails } from '../../features/lead-finder/CandidateDetails'
import { CsvImportDialog } from '../../features/lead-finder/CsvImportDialog'
import type {
  AnalysisResult,
  CandidateRow,
  CandidateView,
  NormalizedCompany,
  ProvidersResponse,
  ScoreResult,
  SearchResponse,
  UsageSummary,
} from '../../features/lead-finder/types'

const PAGE_SIZE = 20
const COLUMNS =
  'id, provider, external_id, search_id, status, lead_id, can_store_content, can_export, can_save_to_crm, company_name, sector, address, city, region, country, website, phone, source_url, attribution, score, priority, score_basis, score_breakdown, analysis, last_analyzed_at, acquired_at, last_seen_at'

type Notice = { tone: 'ok' | 'danger' | 'signal'; text: string } | null
type JobState = { jobId: string; status: string; error?: string | null }
/** Dati di sessione per le fonti senza memorizzazione (Google): solo in memoria, mai persistiti. */
type SessionEntry = { company: NormalizedCompany; score: ScoreResult; analysis?: AnalysisResult }

export default function LeadFinder() {
  const { t } = useI18n()
  const { currentOrg } = useAuth()
  const orgId = currentOrg?.id ?? ''

  const [providers, setProviders] = useState<ProvidersResponse | null>(null)
  const [providersError, setProvidersError] = useState<string | null>(null)
  const [usage, setUsage] = useState<UsageSummary | null>(null)
  const [notice, setNotice] = useState<Notice>(null)

  const [searching, setSearching] = useState(false)
  const [stage, setStage] = useState<Stage | null>(null)
  const [lastSearch, setLastSearch] = useState<{ id: string; counts?: SearchResponse['counts'] } | null>(null)
  const session = useRef(new Map<string, SessionEntry>())

  const [filters, setFilters] = useState<TableFilters>({ scope: 'all', q: '', status: 'active', priority: '', provider: '', sort: 'score' })
  const q = useDebounced(filters.q.trim(), 300)
  const [page, setPage] = useState(1)
  const [rows, setRows] = useState<CandidateRow[]>([])
  const [total, setTotal] = useState(0)
  const [tableLoading, setTableLoading] = useState(true)
  const [tableError, setTableError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [jobs, setJobs] = useState<Record<string, JobState>>({})
  const [detailsId, setDetailsId] = useState<string | null>(null)
  const [csvOpen, setCsvOpen] = useState(false)
  const [, forceRender] = useState(0)

  // ── Fonti e crediti ─────────────────────────────────────────────────────
  const loadProviders = useCallback(async () => {
    if (!orgId) return
    setProvidersError(null)
    try {
      setProviders(await apiFetch<ProvidersResponse>(`/api/lead-finder/providers?organization_id=${orgId}`))
    } catch (err) {
      setProvidersError(apiErrorMessage(err, t))
    }
  }, [orgId, t])

  const loadUsage = useCallback(async () => {
    if (!supabase || !orgId) return
    const { data } = await supabase.rpc('usage_summary', { p_org: orgId })
    if (data) setUsage(data as unknown as UsageSummary)
  }, [orgId])

  useEffect(() => {
    void loadProviders()
    void loadUsage()
  }, [loadProviders, loadUsage])

  // ── Candidati (RLS: solo la propria organizzazione) ─────────────────────
  useEffect(() => setPage(1), [q, filters.scope, filters.status, filters.priority, filters.provider, filters.sort])

  const loadCandidates = useCallback(async () => {
    if (!supabase || !orgId) return
    setTableLoading(true)
    setTableError(null)
    let query = supabase.from('lead_candidates').select(COLUMNS, { count: 'exact' }).eq('organization_id', orgId)
    if (filters.scope === 'last' && lastSearch) query = query.eq('search_id', lastSearch.id)
    query = filters.status === 'active' ? query.neq('status', 'excluded') : query.eq('status', filters.status)
    if (filters.priority) query = query.eq('priority', filters.priority)
    if (filters.provider) query = query.eq('provider', filters.provider)
    if (q) query = query.ilike('company_name', `%${escapeLike(q)}%`)
    query =
      filters.sort === 'name'
        ? query.order('company_name', { ascending: true, nullsFirst: false })
        : filters.sort === 'date'
          ? query.order('last_seen_at', { ascending: false })
          : query.order('score', { ascending: false, nullsFirst: false }).order('last_seen_at', { ascending: false })
    const { data, count, error } = await query.range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1)
    if (error) setTableError(t('leadFinder.loadError'))
    else {
      setRows((data ?? []) as unknown as CandidateRow[])
      setTotal(count ?? 0)
    }
    setTableLoading(false)
  }, [orgId, filters.scope, filters.status, filters.priority, filters.provider, filters.sort, q, page, lastSearch, t])

  useEffect(() => {
    void loadCandidates()
  }, [loadCandidates])

  const views: CandidateView[] = useMemo(
    () =>
      rows.map((r) => {
        const s = !r.can_store_content ? session.current.get(r.external_id) : undefined
        if (!s) return { ...r, sessionOnly: !r.can_store_content, sessionScore: null }
        const c = s.company
        return {
          ...r,
          company_name: c.companyName,
          sector: c.sector,
          address: c.address,
          city: c.city,
          region: c.region,
          country: c.country,
          website: c.website,
          phone: c.phone,
          source_url: c.sourceUrl,
          analysis: s.analysis ?? null,
          sessionOnly: true,
          sessionScore: s.score,
        }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, jobs],
  )

  // ── Ricerca con avanzamento reale ────────────────────────────────────────
  async function runSearch(v: SearchFormValues) {
    if (!supabase) return
    setNotice(null)
    setSearching(true)
    setStage('querying_provider')
    const searchId = crypto.randomUUID()
    const db = supabase
    let polling = true
    const poll = async () => {
      while (polling) {
        const { data } = await db.from('lead_searches').select('stage').eq('id', searchId).maybeSingle()
        const s = data?.stage as Stage | undefined
        if (s && (STAGES as readonly string[]).includes(s)) setStage(s)
        await new Promise((r) => setTimeout(r, 700))
      }
    }
    void poll()
    try {
      const res = await apiFetch<SearchResponse>('/api/lead-finder/search', {
        method: 'POST',
        body: { organization_id: orgId, search_id: searchId, ...v },
      })
      for (const e of res.ephemeral ?? []) session.current.set(e.company.externalId, { company: e.company, score: e.score })
      setStage('done')
      setLastSearch({ id: searchId, counts: res.counts })
      setFilters((f) => ({ ...f, scope: 'last', status: 'active', provider: '', priority: '', q: '' }))
      setNotice(
        res.counts.found === 0
          ? { tone: 'signal', text: t('leadFinder.summaryEmpty') }
          : { tone: 'ok', text: t('leadFinder.summary', { found: res.counts.found, new: res.counts.new, known: res.counts.already_known, crm: res.counts.in_crm }) },
      )
    } catch (err) {
      setStage(null)
      setNotice({ tone: 'danger', text: apiErrorMessage(err, t) })
    } finally {
      polling = false
      setSearching(false)
      void loadUsage()
    }
  }

  // ── Analisi AI (job in background + polling) ─────────────────────────────
  async function analyze(c: CandidateView) {
    setNotice(null)
    try {
      const s = session.current.get(c.external_id)
      const res = await apiFetch<{ job_id: string }>('/api/lead-finder/analyze', {
        method: 'POST',
        body: {
          organization_id: orgId,
          candidate_id: c.id,
          keywords: [],
          ...(c.can_store_content || !s
            ? {}
            : { ephemeral: { companyName: s.company.companyName, sector: s.company.sector, address: s.company.address, city: s.company.city, country: s.company.country, website: s.company.website, phone: s.company.phone } }),
        },
      })
      setJobs((j) => ({ ...j, [c.id]: { jobId: res.job_id, status: 'queued' } }))
    } catch (err) {
      setNotice({ tone: 'danger', text: apiErrorMessage(err, t) })
    }
  }

  const activeJobs = Object.entries(jobs).filter(([, j]) => j.status === 'queued' || j.status === 'running')
  useEffect(() => {
    if (!supabase || activeJobs.length === 0) return
    const db = supabase
    const timer = setInterval(async () => {
      const ids = activeJobs.map(([, j]) => j.jobId)
      const { data } = await db.from('ai_jobs').select('id, status, error, output, candidate_id').in('id', ids)
      let finished = false
      setJobs((prev) => {
        const next = { ...prev }
        for (const row of data ?? []) {
          const cid = row.candidate_id as string
          if (!next[cid] || next[cid].jobId !== row.id) continue
          next[cid] = { jobId: row.id, status: row.status, error: row.error }
          if (row.status === 'succeeded' || row.status === 'failed') finished = true
          const out = row.output as { analysis?: AnalysisResult; score?: ScoreResult } | null
          if (row.status === 'succeeded' && out?.analysis) {
            const cand = rows.find((r) => r.id === cid)
            const entry = cand && session.current.get(cand.external_id)
            if (entry) session.current.set(cand.external_id, { ...entry, analysis: out.analysis, score: out.score ?? entry.score })
          }
        }
        return next
      })
      if (finished) {
        void loadCandidates()
        void loadUsage()
        forceRender((n) => n + 1)
      }
    }, 2000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeJobs.map(([, j]) => j.jobId).join(','), rows])

  // ── Salvataggio, esclusione, esportazione ────────────────────────────────
  async function save(ids: string[]) {
    setNotice(null)
    try {
      const res = await apiFetch<{ results: { outcome: string }[]; saved: number }>('/api/lead-finder/save', {
        method: 'POST',
        body: { organization_id: orgId, candidate_ids: ids },
      })
      const dup = res.results.filter((r) => r.outcome === 'duplicate' || r.outcome === 'already_saved').length
      const blocked = res.results.filter((r) => ['not_allowed', 'excluded', 'suppressed', 'not_found'].includes(r.outcome)).length
      setNotice({ tone: res.saved ? 'ok' : 'signal', text: ids.length === 1 && res.saved === 1 ? t('leadFinder.savedToast', { count: 1 }) : t('leadFinder.saveOutcomes', { saved: res.saved, dup, blocked }) })
      setSelected(new Set())
      void loadCandidates()
    } catch (err) {
      setNotice({ tone: 'danger', text: apiErrorMessage(err, t) })
    }
  }

  async function exclude(ids: string[], excluded: boolean) {
    setNotice(null)
    try {
      const res = await apiFetch<{ changed: number }>('/api/lead-finder/exclude', {
        method: 'POST',
        body: { organization_id: orgId, candidate_ids: ids, excluded },
      })
      setNotice({ tone: 'ok', text: t(excluded ? 'leadFinder.excludedToast' : 'leadFinder.restoredToast', { count: res.changed }) })
      setSelected(new Set())
      void loadCandidates()
    } catch (err) {
      setNotice({ tone: 'danger', text: apiErrorMessage(err, t) })
    }
  }

  async function exportCsv() {
    setNotice(null)
    try {
      const qs = new URLSearchParams({ organization_id: orgId })
      if (filters.scope === 'last' && lastSearch) qs.set('search_id', lastSearch.id)
      const blob = await apiFetch<Blob>(`/api/lead-finder/export?${qs}`, { raw: true })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `leadflow-lead-${new Date().toISOString().slice(0, 10)}.csv`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      setNotice({ tone: 'danger', text: apiErrorMessage(err, t) })
    }
  }

  const selectedIds = [...selected]
  const selectedRows = views.filter((v) => selected.has(v.id))
  const exportable = views.some((v) => v.can_export)
  const detail = views.find((v) => v.id === detailsId) ?? null
  const detailScore: ScoreResult | null = detail
    ? (detail.sessionScore ?? (detail.score !== null && detail.priority && detail.score_basis && detail.score_breakdown ? { score: detail.score, priority: detail.priority, basis: detail.score_basis, breakdown: detail.score_breakdown } : null))
    : null
  const configuredProviders = providers?.providers.filter((p) => p.configured) ?? []

  return (
    <>
      <PageHeader
        title={t('leadFinder.title')}
        subtitle={t('leadFinder.subtitle')}
        actions={
          <Button variant="secondary" onClick={() => setCsvOpen(true)}>
            <FileUp className="size-4" aria-hidden />
            {t('leadFinder.importCsv')}
          </Button>
        }
      />

      <div className="space-y-5">
        <UsageMeter usage={usage} />

        {providersError ? (
          <ErrorState message={providersError} onRetry={() => void loadProviders()} className="rounded-[var(--radius-panel)] border border-line bg-surface" />
        ) : !providers ? (
          <LoadingState />
        ) : (
          <div className="grid gap-5 xl:grid-cols-[1.35fr_1fr]">
            <div className="space-y-4">
              {configuredProviders.length === 0 && <NoProviderNotice />}
              <SearchForm providers={providers.providers} busy={searching} onSubmit={(v) => void runSearch(v)} />
            </div>
            <ProviderStatus data={providers} />
          </div>
        )}

        {stage && (searching || stage === 'done') && <SearchProgress stage={stage} />}
        <div aria-live="polite">{notice && <InlineAlert tone={notice.tone}>{notice.text}</InlineAlert>}</div>

        <section aria-labelledby="results-title" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="results-title" className="text-lg font-semibold">
              {t('leadFinder.resultsTitle')}
            </h2>
            <div className="flex flex-wrap items-center gap-2">
              {selectedIds.length > 0 && <span className="text-sm text-muted">{t('leadFinder.bulkSelected', { count: selectedIds.length })}</span>}
              <Button size="sm" variant="secondary" disabled={!selectedRows.some((r) => r.can_save_to_crm && r.status === 'new')} onClick={() => void save(selectedIds)}>
                <UserPlus className="size-4" aria-hidden />
                {t('leadFinder.actSave')}
              </Button>
              <Button size="sm" variant="secondary" disabled={!selectedRows.some((r) => r.status === 'new')} onClick={() => void exclude(selectedIds, true)}>
                <Ban className="size-4" aria-hidden />
                {t('leadFinder.actExclude')}
              </Button>
              <Button size="sm" variant="secondary" disabled={!exportable} title={!exportable ? t('leadFinder.exportNotAllowed') : undefined} onClick={() => void exportCsv()}>
                <Download className="size-4" aria-hidden />
                {t('leadFinder.actExport')}
              </Button>
            </div>
          </div>
          <CandidatesTable
            rows={views}
            total={total}
            page={page}
            pageSize={PAGE_SIZE}
            loading={tableLoading}
            error={tableError}
            filters={filters}
            hasLastSearch={!!lastSearch}
            selected={selected}
            jobs={Object.fromEntries(Object.entries(jobs).map(([k, v]) => [k, { status: v.status }]))}
            aiConfigured={!!providers?.ai.configured}
            onFilters={(f) => setFilters((s) => ({ ...s, ...f }))}
            onPage={setPage}
            onToggle={(id) =>
              setSelected((s) => {
                const n = new Set(s)
                if (n.has(id)) n.delete(id)
                else n.add(id)
                return n
              })
            }
            onToggleAll={(ids, on) =>
              setSelected((s) => {
                const n = new Set(s)
                for (const id of ids) {
                  if (on) n.add(id)
                  else n.delete(id)
                }
                return n
              })
            }
            onDetails={(c) => setDetailsId(c.id)}
            onAnalyze={(c) => void analyze(c)}
            onSave={(ids) => void save(ids)}
            onExclude={(ids, ex) => void exclude(ids, ex)}
            onRetry={() => void loadCandidates()}
          />
        </section>
      </div>

      {detail && (
        <CandidateDetails
          candidate={detail}
          analysis={detail.analysis}
          score={detailScore}
          jobStatus={jobs[detail.id] ?? null}
          aiConfigured={!!providers?.ai.configured}
          onClose={() => setDetailsId(null)}
          onAnalyze={() => void analyze(detail)}
          onSave={() => void save([detail.id])}
        />
      )}
      {csvOpen && (
        <CsvImportDialog
          open
          orgId={orgId}
          onClose={() => setCsvOpen(false)}
          onImported={(searchId, message) => {
            setCsvOpen(false)
            setLastSearch({ id: searchId })
            setFilters((f) => ({ ...f, scope: 'last', status: 'active', provider: '', priority: '', q: '' }))
            setNotice({ tone: 'ok', text: message })
            void loadUsage()
          }}
        />
      )}
    </>
  )
}

