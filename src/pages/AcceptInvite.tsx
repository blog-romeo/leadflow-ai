import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { AuthLayout } from '../components/layout/AuthLayout'
import { Field, Select } from '../components/ui/Field'
import { Button } from '../components/ui/Button'
import { InlineAlert, LoadingState } from '../components/ui/States'
import { useI18n } from '../i18n'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import { normalizeVat, validateVatNumber } from '../lib/validation'
import { COUNTRIES } from '../config/countries'

interface Preview { organization_name: string; client_plan_code: string; status: 'pending' | 'accepted' | 'revoked' | 'expired'; reseller_name: string }

/**
 * Accettazione di un invito di un rivenditore. Il token è verificato dal database
 * (hash, scadenza, email dell'account, limiti del rivenditore): il client non decide nulla.
 */
export default function AcceptInvite() {
  const { t, locale } = useI18n()
  const { refresh, setCurrentOrgId } = useAuth()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const token = params.get('token') ?? ''
  const [preview, setPreview] = useState<Preview | null>(null)
  const [problem, setProblem] = useState<string | null>(token ? null : t('invite.missing'))
  const [vat, setVat] = useState('')
  const [country, setCountry] = useState('IT')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!token || !supabase) return
    void supabase.rpc('invitation_preview', { p_token: token }).then(({ data, error }) => {
      if (error) return setProblem(t('invite.notFound'))
      const p = data as unknown as Preview
      setPreview(p)
      if (p.status === 'expired') setProblem(t('invite.expired'))
      else if (p.status !== 'pending') setProblem(t('invite.used'))
    })
  }, [token, t])

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!supabase) return
    const v = validateVatNumber(vat)
    if (!v.ok) return setProblem(t(v.error ?? 'validation.vatInvalid'))
    setBusy(true)
    setProblem(null)
    const { data, error } = await supabase.rpc('accept_reseller_invitation', { p_token: token, p_vat_number: normalizeVat(vat), p_country: country })
    setBusy(false)
    if (error) {
      const m = error.message ?? ''
      return setProblem(m.includes('expired') ? t('invite.expired') : m.includes('reseller_') ? t('invite.unavailable') : m.includes('not_pending') ? t('invite.used') : t('invite.notFound'))
    }
    await refresh()
    setCurrentOrgId(data as unknown as string)
    navigate('/app', { replace: true })
  }

  return (
    <AuthLayout title={t('invite.title')} subtitle={preview ? t('invite.subtitle', { reseller: preview.reseller_name, org: preview.organization_name }) : undefined}>
      {!preview && !problem ? <LoadingState /> : (
        <form onSubmit={onSubmit} className="space-y-4">
          {problem && <InlineAlert>{problem}</InlineAlert>}
          {preview && <p className="text-sm text-muted capitalize">{t('invite.plan', { plan: preview.client_plan_code })}</p>}
          {preview?.status === 'pending' && (
            <>
              <Field label={t('invite.vat')} value={vat} onChange={(e) => setVat(e.target.value)} autoComplete="off" />
              <Select label={t('invite.country')} value={country} onChange={(e) => setCountry(e.target.value)}>
                {COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.name[locale]}</option>)}
              </Select>
              <Button type="submit" className="w-full" loading={busy}>{t('invite.accept')}</Button>
            </>
          )}
        </form>
      )}
    </AuthLayout>
  )
}
