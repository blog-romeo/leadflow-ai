import { useCallback, useEffect, useMemo, useState, type DragEvent } from 'react'
import { Link } from 'react-router-dom'
import { GripVertical, Search } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { useI18n } from '../../i18n'
import { supabase } from '../../lib/supabase'
import { PIPELINE_STAGES, type LeadStatus } from '../../lib/database.types'
import { PageHeader } from '../../components/ui/PageHeader'
import { Badge } from '../../components/ui/Badge'
import { controlClasses } from '../../components/ui/Field'
import { ErrorState, InlineAlert, LoadingState } from '../../components/ui/States'
import { cn } from '../../lib/cn'
import { CrmTabs } from '../../features/sales/CrmTabs'
import { StageSelect } from '../../features/sales/StageSelect'
import { salesErrorMessage } from '../../features/sales/errors'

type Card = { id: string; company_name: string; city: string | null; status: LeadStatus; contact_status: string; score: number | null; priority: 'high' | 'medium' | 'low' | null }
const LIMIT = 500

export default function Pipeline() {
  const { t } = useI18n()
  const { currentOrg } = useAuth()
  const orgId = currentOrg?.id ?? ''
  const [cards, setCards] = useState<Card[] | null>(null)
  const [error, setError] = useState(false)
  const [q, setQ] = useState('')
  const [dragId, setDragId] = useState<string | null>(null)
  const [over, setOver] = useState<LeadStatus | null>(null)
  const [notice, setNotice] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null)

  const load = useCallback(async () => {
    if (!supabase || !orgId) return
    const { data, error: e } = await supabase
      .from('leads')
      .select('id, company_name, city, status, contact_status, score, priority')
      .eq('organization_id', orgId)
      .is('deleted_at', null)
      .order('score', { ascending: false, nullsFirst: false })
      .limit(LIMIT)
    setError(!!e)
    setCards((data ?? []) as Card[])
  }, [orgId])

  useEffect(() => {
    void load()
  }, [load])

  const filtered = useMemo(() => {
    const f = q.trim().toLowerCase()
    return (cards ?? []).filter((c) => !f || c.company_name.toLowerCase().includes(f))
  }, [cards, q])

  async function move(card: Card, to: LeadStatus) {
    if (!supabase || card.status === to) return
    const prev = card.status
    setCards((cs) => cs?.map((c) => (c.id === card.id ? { ...c, status: to } : c)) ?? null)
    const { error: e } = await supabase.from('leads').update({ status: to }).eq('id', card.id)
    if (e) {
      setCards((cs) => cs?.map((c) => (c.id === card.id ? { ...c, status: prev } : c)) ?? null)
      setNotice({ tone: 'danger', text: salesErrorMessage(e, t) })
    } else {
      setNotice({ tone: 'ok', text: t('sales.pipeline.moved', { name: card.company_name, stage: t(`status.${to}`) }) })
    }
  }

  function onDrop(e: DragEvent, stage: LeadStatus) {
    e.preventDefault()
    setOver(null)
    const id = e.dataTransfer.getData('text/plain') || dragId
    const card = cards?.find((c) => c.id === id)
    if (card) void move(card, stage)
    setDragId(null)
  }

  return (
    <>
      <PageHeader title={t('sales.pipeline.title')} subtitle={t('sales.pipeline.subtitle')} actions={<CrmTabs />} />
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative max-w-sm flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden />
          <label htmlFor="pipe-search" className="sr-only">
            {t('sales.pipeline.search')}
          </label>
          <input id="pipe-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('sales.pipeline.search')} className={cn(controlClasses, 'pl-9')} />
        </div>
        {cards && cards.length >= LIMIT && <p className="text-xs text-muted">{t('sales.pipeline.truncated', { count: LIMIT })}</p>}
      </div>
      <div aria-live="polite" className="mb-3 empty:hidden">
        {notice && <InlineAlert tone={notice.tone}>{notice.text}</InlineAlert>}
      </div>
      {error ? (
        <ErrorState message={t('sales.pipeline.loadError')} onRetry={() => void load()} />
      ) : !cards ? (
        <LoadingState />
      ) : (
        <div className="relative -mx-4 overflow-x-auto px-4 pb-3 sm:mx-0 sm:px-0">
          <ol className="flex gap-3" aria-label={t('sales.pipeline.title')}>
            {PIPELINE_STAGES.map((stage) => {
              const items = filtered.filter((c) => c.status === stage)
              return (
                <li
                  key={stage}
                  onDragOver={(e) => {
                    e.preventDefault()
                    setOver(stage)
                  }}
                  onDragLeave={() => setOver((o) => (o === stage ? null : o))}
                  onDrop={(e) => onDrop(e, stage)}
                  className={cn(
                    'flex w-64 shrink-0 flex-col rounded-[var(--radius-panel)] border bg-surface-2/60',
                    over === stage ? 'border-flow ring-2 ring-flow/30' : 'border-line',
                    stage === 'not_contactable' && 'bg-danger-soft/40',
                  )}
                >
                  <h2 className="flex items-center justify-between px-3 py-2.5 text-sm font-semibold">
                    {t(`status.${stage}`)}
                    <span className="tabular text-xs font-normal text-muted">{items.length}</span>
                  </h2>
                  <ul className="flex min-h-24 flex-col gap-2 px-2 pb-2">
                    {items.length === 0 && <li className="px-1 py-3 text-center text-xs text-muted">{t('sales.pipeline.emptyColumn')}</li>}
                    {items.map((c) => {
                      const contactable = c.contact_status === 'active' && c.status !== 'not_contactable'
                      return (
                        <li
                          key={c.id}
                          draggable
                          onDragStart={(e) => {
                            e.dataTransfer.setData('text/plain', c.id)
                            e.dataTransfer.effectAllowed = 'move'
                            setDragId(c.id)
                          }}
                          onDragEnd={() => setDragId(null)}
                          className={cn('rounded-[var(--radius-control)] border border-line bg-surface p-2.5 shadow-sm', dragId === c.id && 'opacity-50')}
                        >
                          <div className="flex items-start gap-1.5">
                            <GripVertical className="mt-0.5 size-4 shrink-0 cursor-grab text-muted" aria-hidden />
                            <div className="min-w-0 flex-1">
                              <Link to={`/app/sales-agent/leads/${c.id}`} className="block truncate text-sm font-medium hover:text-flow hover:underline">
                                {c.company_name}
                              </Link>
                              <p className="truncate text-xs text-muted">{c.city ?? ''}</p>
                            </div>
                            {c.score !== null && <span className="tabular font-display text-sm font-semibold">{c.score}</span>}
                          </div>
                          <div className="mt-2 flex items-center gap-1.5">
                            {c.priority && <Badge tone={c.priority === 'high' ? 'ok' : c.priority === 'medium' ? 'signal' : 'neutral'}>{t(`leadFinder.priority.${c.priority}`)}</Badge>}
                            {!contactable && <Badge tone="danger">{t('sales.lead.notContactable')}</Badge>}
                          </div>
                          <div className="mt-2">
                            <StageSelect
                              compact
                              leadId={c.id}
                              name={c.company_name}
                              value={c.status}
                              contactable={c.contact_status === 'active'}
                              onChanged={(s) => {
                                setCards((cs) => cs?.map((x) => (x.id === c.id ? { ...x, status: s } : x)) ?? null)
                                setNotice({ tone: 'ok', text: t('sales.pipeline.moved', { name: c.company_name, stage: t(`status.${s}`) }) })
                              }}
                              onError={(text) => setNotice({ tone: 'danger', text })}
                            />
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                </li>
              )
            })}
          </ol>
        </div>
      )}
    </>
  )
}
