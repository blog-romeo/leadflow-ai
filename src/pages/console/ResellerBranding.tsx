import { useEffect, useState } from 'react'
import { Store } from 'lucide-react'
import { useI18n } from '../../i18n'
import { PageHeader } from '../../components/ui/PageHeader'
import { Panel } from '../../components/ui/Panel'
import { Button } from '../../components/ui/Button'
import { EmptyState, ErrorState, InlineAlert, LoadingState } from '../../components/ui/States'
import { consoleError, inputCls, post, useApi } from '../../features/console/shared'
import { inkFor } from '../../lib/theme'
import { useReseller } from './ResellerDashboard'

interface Branding {
  platform_name: string | null
  primary_color: string | null
  secondary_color: string | null
  theme: 'light' | 'dark' | 'system'
  welcome_title: string | null
  welcome_text: string | null
  support_email: string | null
  privacy_url: string | null
  terms_url: string | null
  logo_url: string | null
  login_logo_url: string | null
  favicon_url: string | null
}
interface Dash { role: string; access: { has_access: boolean; features: string[] }; flags: { custom_branding: boolean }; branding: Branding | null }

const TEXT_FIELDS = ['platform_name', 'welcome_title', 'welcome_text', 'support_email', 'privacy_url', 'terms_url'] as const
const HEX = /^#[0-9a-f]{6}$/i
const ACCEPT: Record<string, string> = { logo: 'image/png,image/jpeg,image/webp', login_logo: 'image/png,image/jpeg,image/webp', favicon: 'image/png,image/x-icon,image/vnd.microsoft.icon' }

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).replace(/^data:[^;]+;base64,/, ''))
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })
}

export default function ResellerBranding() {
  const { t } = useI18n()
  const { current, loading: lLoading } = useReseller()
  const { data, error, loading, reload } = useApi<Dash>(current ? `/api/reseller/dashboard?reseller_id=${current.id}` : null)
  const [form, setForm] = useState<Branding | null>(null)
  const [msg, setMsg] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    if (data) setForm({ platform_name: null, primary_color: null, secondary_color: null, theme: 'system', welcome_title: null, welcome_text: null, support_email: null, privacy_url: null, terms_url: null, logo_url: null, login_logo_url: null, favicon_url: null, ...(data.branding ?? {}) })
  }, [data])

  if (lLoading) return <LoadingState />
  if (!current) return <EmptyState icon={Store} title={t('console.resellerForbidden')} className="py-20" />
  if (loading && !data) return <LoadingState />
  if (error || !data || !form) return <ErrorState message={t('console.loadError')} onRetry={() => void reload()} />

  const enabled = data.role === 'reseller_admin' && data.access.has_access && data.access.features.includes('custom_branding') && data.flags.custom_branding
  const set = (k: keyof Branding, v: string) => setForm({ ...form, [k]: v })
  const save = async () => {
    setBusy('save')
    setMsg(null)
    try {
      const patch: Record<string, unknown> = { theme: form.theme, primary_color: form.primary_color && HEX.test(form.primary_color) ? form.primary_color : null, secondary_color: form.secondary_color && HEX.test(form.secondary_color) ? form.secondary_color : null }
      for (const k of TEXT_FIELDS) patch[k] = (form[k] ?? '').trim() || null
      await post('/api/reseller/branding', { reseller_id: current.id, patch })
      setMsg({ tone: 'ok', text: t('brandingEditor.saved') })
      void reload()
    } catch (err) {
      setMsg({ tone: 'danger', text: consoleError(err, t) })
    } finally {
      setBusy(null)
    }
  }
  const upload = async (kind: 'logo' | 'login_logo' | 'favicon', file: File | null, remove = false) => {
    setBusy(kind)
    setMsg(null)
    try {
      const body: Record<string, unknown> = { reseller_id: current.id, kind }
      if (remove) body.remove = true
      else if (file) Object.assign(body, { content_type: file.type, data_base64: await readBase64(file) })
      await post('/api/reseller/branding-asset', body)
      void reload()
    } catch (err) {
      setMsg({ tone: 'danger', text: consoleError(err, t) })
    } finally {
      setBusy(null)
    }
  }
  const primary = form.primary_color && HEX.test(form.primary_color) ? form.primary_color : '#0b7a75'
  const secondary = form.secondary_color && HEX.test(form.secondary_color) ? form.secondary_color : '#a86a00'

  return (
    <>
      <PageHeader title={t('brandingEditor.title')} subtitle={t('brandingEditor.subtitle')} />
      {!enabled && <div className="mb-4"><InlineAlert tone="signal">{t('brandingEditor.notAvailable')}</InlineAlert></div>}
      {msg && <div className="mb-4"><InlineAlert tone={msg.tone}>{msg.text}</InlineAlert></div>}
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <Panel title={t('brandingEditor.title')}>
          <fieldset disabled={!enabled} className="space-y-3 text-sm">
            <label className="block">{t('brandingEditor.platformName')}<input className={inputCls} maxLength={60} value={form.platform_name ?? ''} onChange={(e) => set('platform_name', e.target.value)} /></label>
            <div className="grid grid-cols-2 gap-3">
              {(['primary_color', 'secondary_color'] as const).map((k) => (
                <label key={k} className="block">{t(k === 'primary_color' ? 'brandingEditor.primary' : 'brandingEditor.secondary')}
                  <span className="flex gap-2">
                    <input type="color" value={k === 'primary_color' ? primary : secondary} onChange={(e) => set(k, e.target.value)} className="h-9 w-12 rounded border border-line" aria-label={k} />
                    <input className={`${inputCls} font-mono`} maxLength={7} value={form[k] ?? ''} placeholder="#1d4ed8" onChange={(e) => set(k, e.target.value)} />
                  </span>
                </label>
              ))}
            </div>
            <label className="block">{t('brandingEditor.theme')}
              <select className={inputCls} value={form.theme} onChange={(e) => set('theme', e.target.value)}>
                {(['system', 'light', 'dark'] as const).map((th) => <option key={th} value={th}>{t(`brandingEditor.themes.${th}`)}</option>)}
              </select>
            </label>
            <label className="block">{t('brandingEditor.welcomeTitle')}<input className={inputCls} maxLength={120} value={form.welcome_title ?? ''} onChange={(e) => set('welcome_title', e.target.value)} /></label>
            <label className="block">{t('brandingEditor.welcomeText')}<textarea className={`${inputCls} h-20 py-1`} maxLength={600} value={form.welcome_text ?? ''} onChange={(e) => set('welcome_text', e.target.value)} /></label>
            <p className="text-xs text-muted">{t('brandingEditor.noMarkup')}</p>
            <label className="block">{t('brandingEditor.supportEmail')}<input className={inputCls} type="email" value={form.support_email ?? ''} onChange={(e) => set('support_email', e.target.value)} /></label>
            <label className="block">{t('brandingEditor.privacyUrl')}<input className={inputCls} type="url" pattern="https://.*" value={form.privacy_url ?? ''} onChange={(e) => set('privacy_url', e.target.value)} /></label>
            <label className="block">{t('brandingEditor.termsUrl')}<input className={inputCls} type="url" pattern="https://.*" value={form.terms_url ?? ''} onChange={(e) => set('terms_url', e.target.value)} /></label>
            <Button onClick={() => void save()} loading={busy === 'save'}>{t('console.save')}</Button>

            <div className="space-y-3 border-t border-line pt-4">
              <p className="text-xs text-muted">{t('brandingEditor.imageHint')}</p>
              {([['logo', 'logo_url', 'brandingEditor.logo'], ['login_logo', 'login_logo_url', 'brandingEditor.loginLogo'], ['favicon', 'favicon_url', 'brandingEditor.favicon']] as const).map(([kind, urlKey, label]) => (
                <div key={kind} className="flex flex-wrap items-center gap-3">
                  <span className="w-40 font-medium">{t(label)}</span>
                  {form[urlKey] ? <img src={form[urlKey]!} alt="" className="h-8 max-w-[120px] object-contain" referrerPolicy="no-referrer" /> : <span className="text-xs text-muted">—</span>}
                  <input type="file" accept={ACCEPT[kind]} className="text-xs" aria-label={t(label)} onChange={(e) => void upload(kind, e.target.files?.[0] ?? null)} disabled={busy === kind} />
                  {form[urlKey] && <Button size="sm" variant="ghost" onClick={() => void upload(kind, null, true)}>{t('brandingEditor.removeImage')}</Button>}
                </div>
              ))}
            </div>
          </fieldset>
        </Panel>

        <Panel title={t('brandingEditor.preview')}>
          {/* Anteprima con stili inline generati solo da colori esadecimali validati. */}
          <div className="overflow-hidden rounded-lg border border-line">
            <div className="flex items-center gap-2 px-4 py-3" style={{ background: primary, color: inkFor(primary) }}>
              {form.logo_url ? <img src={form.logo_url} alt="" className="h-7 max-w-[120px] object-contain" referrerPolicy="no-referrer" /> : null}
              <span className="font-semibold">{form.platform_name || 'LeadFlow AI'}</span>
            </div>
            <div className="space-y-2 p-4">
              <p className="font-display text-lg font-semibold">{form.welcome_title || '—'}</p>
              <p className="text-sm text-muted">{form.welcome_text || ''}</p>
              <span className="inline-block rounded-full px-2 py-0.5 text-xs" style={{ background: secondary, color: inkFor(secondary) }}>{t('brandingEditor.secondary')}</span>
              <div><button type="button" className="mt-2 rounded-md px-3 py-1.5 text-sm" style={{ background: primary, color: inkFor(primary) }}>{t('console.save')}</button></div>
            </div>
          </div>
        </Panel>
      </div>
    </>
  )
}
