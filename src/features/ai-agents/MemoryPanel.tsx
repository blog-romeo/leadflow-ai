import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Trash2 } from 'lucide-react'
import { useI18n } from '../../i18n'
import { supabase } from '../../lib/supabase'
import { AI_MEMORY_CATEGORIES, type AiCompanyMemoryRow, type AiMemoryCategory, type Json } from '../../lib/database.types'
import { Button } from '../../components/ui/Button'
import { Field, Select, controlClasses } from '../../components/ui/Field'
import { Badge } from '../../components/ui/Badge'
import { InlineAlert, LoadingState } from '../../components/ui/States'
import { codeMessage } from './shared'

/** Memoria aziendale: versionata, con scadenza, isolata per organizzazione (RLS + RPC con controllo ruolo). */
export function MemoryPanel({ orgId, isAdmin }: { orgId: string; isAdmin: boolean }) {
  const { t, formatDate } = useI18n()
  const [rows, setRows] = useState<AiCompanyMemoryRow[] | null>(null)
  const editable = AI_MEMORY_CATEGORIES.filter((c) => c !== 'campaign_results' && c !== 'approved_feedback' && (isAdmin || c === 'user_feedback'))
  const [category, setCategory] = useState<AiMemoryCategory>(editable[0] ?? 'user_feedback')
  const [key, setKey] = useState('')
  const [content, setContent] = useState('')
  const [retention, setRetention] = useState('365')
  const [msg, setMsg] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    if (!supabase) return
    const { data } = await supabase.from('ai_company_memory').select('*').eq('organization_id', orgId).eq('status', 'active').order('created_at', { ascending: false }).limit(100)
    setRows((data ?? []) as AiCompanyMemoryRow[])
  }, [orgId])
  useEffect(() => {
    void load()
  }, [load])

  async function save(e: FormEvent) {
    e.preventDefault()
    if (!supabase || !content.trim()) return
    setBusy(true)
    setMsg(null)
    const { error } = await supabase.rpc('ai_memory_upsert', {
      p_org: orgId,
      p_category: category,
      p_entry_key: key.trim().toLowerCase() || 'default',
      p_content: { text: content.trim().slice(0, 4000) } as Json,
      p_retention_days: Math.min(Math.max(Number(retention) || 365, 1), 1095),
    })
    setBusy(false)
    if (error) return setMsg({ tone: 'danger', text: codeMessage(/^[a-z_]{3,60}$/.test(error.message) ? error.message : 'generic', t) })
    setContent('')
    setMsg({ tone: 'ok', text: t('aiAgents.memory.saved') })
    void load()
  }

  async function remove(r: AiCompanyMemoryRow) {
    if (!supabase || !window.confirm(t('aiAgents.memory.deleteConfirm'))) return
    await supabase.rpc('ai_memory_delete', { p_org: orgId, p_category: r.category, p_entry_key: r.entry_key })
    void load()
  }

  const preview = (c: Json) => {
    const o = c && typeof c === 'object' && !Array.isArray(c) ? (c as Record<string, unknown>) : {}
    const text = typeof o.text === 'string' ? o.text : JSON.stringify(c)
    return text.length > 220 ? `${text.slice(0, 220)}…` : text
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">{t('aiAgents.memory.intro')}</p>
      {rows === null ? (
        <LoadingState />
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted">{t('aiAgents.memory.empty')}</p>
      ) : (
        <ul className="divide-y divide-line">
          {rows.map((r) => (
            <li key={r.id} className="flex items-start justify-between gap-3 py-2.5 text-sm">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="flow">{t(`aiAgents.memory.categories.${r.category}`)}</Badge>
                  <span className="font-medium">{r.entry_key}</span>
                  <span className="text-xs text-muted">
                    {t('aiAgents.memory.version', { version: r.version })} · {t('aiAgents.memory.expires', { date: formatDate(r.expires_at) })}
                  </span>
                </div>
                <p className="mt-1 break-words text-muted">{preview(r.content)}</p>
              </div>
              {isAdmin && (
                <Button variant="ghost" size="sm" aria-label={t('aiAgents.memory.delete')} onClick={() => void remove(r)}>
                  <Trash2 className="size-4" aria-hidden />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={save} className="space-y-3 border-t border-line pt-4">
        {!isAdmin && <p className="text-xs text-muted">{t('aiAgents.memory.memberHint')}</p>}
        <div className="grid gap-3 sm:grid-cols-3">
          <Select label={t('aiAgents.memory.category')} value={category} onChange={(e) => setCategory(e.target.value as AiMemoryCategory)}>
            {editable.map((c) => (
              <option key={c} value={c}>
                {t(`aiAgents.memory.categories.${c}`)}
              </option>
            ))}
          </Select>
          <Field label={t('aiAgents.memory.key')} hint={t('aiAgents.memory.keyHint')} value={key} maxLength={80} pattern="[a-z0-9][a-z0-9_.:\-]{0,79}" onChange={(e) => setKey(e.target.value)} />
          <Field label={t('aiAgents.memory.retention')} type="number" min={1} max={1095} value={retention} onChange={(e) => setRetention(e.target.value)} />
        </div>
        <label className="block space-y-1.5">
          <span className="block text-sm font-medium">{t('aiAgents.memory.content')}</span>
          <textarea className={`${controlClasses} h-24 py-2`} maxLength={4000} value={content} onChange={(e) => setContent(e.target.value)} />
        </label>
        {msg && <InlineAlert tone={msg.tone}>{msg.text}</InlineAlert>}
        <Button type="submit" loading={busy} disabled={!content.trim()}>
          {t('aiAgents.memory.add')}
        </Button>
      </form>
    </div>
  )
}
