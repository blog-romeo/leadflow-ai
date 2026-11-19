import { useState, type FormEvent } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { AuthLayout } from '../components/layout/AuthLayout'
import { Field, Select } from '../components/ui/Field'
import { Button } from '../components/ui/Button'
import { InlineAlert } from '../components/ui/States'
import { useI18n } from '../i18n'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import { normalizeVat, validateOrganizationName, validateVatNumber } from '../lib/validation'
import { errorKey } from '../lib/errors'
import { COUNTRIES } from '../config/countries'

export default function Onboarding() {
  const { t, locale } = useI18n()
  const { user, currentOrg, refresh, setCurrentOrgId, signOut } = useAuth()
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [vat, setVat] = useState('')
  const [country, setCountry] = useState('IT')
  const [errors, setErrors] = useState<{ name?: string | null; vat?: string | null }>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (currentOrg) return <Navigate to="/app" replace />

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    const n = validateOrganizationName(name)
    const v = validateVatNumber(vat)
    setErrors({ name: n.ok ? null : t(n.error), vat: v.ok ? null : t(v.error) })
    if (!n.ok || !v.ok || !supabase) return
    setBusy(true)
    // La creazione avviene tramite RPC security definer: il server valida input,
    // crea l'organizzazione e assegna il ruolo organization_admin in un'unica transazione.
    const { data, error: err } = await supabase.rpc('create_organization', {
      p_name: name.trim(),
      p_vat_number: normalizeVat(vat),
      p_country: country,
    })
    if (err || !data) {
      setBusy(false)
      return setError(t(errorKey(err)))
    }
    setCurrentOrgId(data.id)
    await refresh()
    setBusy(false)
    navigate('/app', { replace: true })
  }

  return (
    <AuthLayout
      title={t('onboarding.title')}
      subtitle={t('onboarding.body')}
      footer={
        <span className="flex flex-wrap items-center gap-x-2">
          {t('onboarding.signedInAs', { email: user?.email ?? '' })}
          <button type="button" onClick={() => void signOut()} className="font-medium text-flow hover:underline">
            {t('common.signOut')}
          </button>
        </span>
      }
    >
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        {error && <InlineAlert>{error}</InlineAlert>}
        <Field label={t('onboarding.name')} autoComplete="organization" value={name} onChange={(e) => setName(e.target.value)} error={errors.name} maxLength={120} required />
        <Field label={t('onboarding.vat')} value={vat} onChange={(e) => setVat(e.target.value)} hint={t('onboarding.vatHint')} error={errors.vat} maxLength={20} />
        <Select label={t('onboarding.country')} value={country} onChange={(e) => setCountry(e.target.value)}>
          {COUNTRIES.map((c) => (
            <option key={c.code} value={c.code}>
              {c.name[locale]}
            </option>
          ))}
        </Select>
        <Button type="submit" className="w-full" size="lg" loading={busy}>
          {t('onboarding.submit')}
        </Button>
      </form>
    </AuthLayout>
  )
}
