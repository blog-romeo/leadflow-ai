import { useEffect, useState, type FormEvent } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import { useI18n } from '../../i18n'
import { supabase } from '../../lib/supabase'
import { normalizeVat, validateOrganizationName, validateRetentionDays, validateVatNumber } from '../../lib/validation'
import { errorKey } from '../../lib/errors'
import { COUNTRIES } from '../../config/countries'
import { PageHeader } from '../../components/ui/PageHeader'
import { Panel } from '../../components/ui/Panel'
import { Field, Select } from '../../components/ui/Field'
import { Button } from '../../components/ui/Button'
import { InlineAlert } from '../../components/ui/States'
import { LanguageSwitch, ThemeSegmented } from '../../components/ui/Preferences'
import { TeamPanel } from '../../features/team/TeamPanel'
import { AccountDeletionPanel } from '../../features/account/AccountDeletionPanel'


function OrganizationForm() {
  const { t, locale } = useI18n()
  const { currentOrg, isOrgAdmin, refresh } = useAuth()
  const [name, setName] = useState(currentOrg?.name ?? '')
  const [vat, setVat] = useState(currentOrg?.vat_number ?? '')
  const [country, setCountry] = useState(currentOrg?.country ?? 'IT')
  const [retention, setRetention] = useState(String(currentOrg?.data_retention_days ?? 730))
  const [errors, setErrors] = useState<Record<string, string | null>>({})
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setName(currentOrg?.name ?? '')
    setVat(currentOrg?.vat_number ?? '')
    setCountry(currentOrg?.country ?? 'IT')
    setRetention(String(currentOrg?.data_retention_days ?? 730))
  }, [currentOrg])

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setResult(null)
    const days = Number(retention)
    const checks = { name: validateOrganizationName(name), vat: validateVatNumber(vat), retention: validateRetentionDays(days) }
    const next = Object.fromEntries(Object.entries(checks).map(([k, v]) => [k, v.ok ? null : t(v.error)]))
    setErrors(next)
    if (Object.values(next).some(Boolean) || !supabase || !currentOrg) return
    setBusy(true)
    // RLS consente l'update solo agli organization_admin; le colonne modificabili sono limitate da GRANT.
    const { error } = await supabase
      .from('organizations')
      .update({ name: name.trim(), vat_number: normalizeVat(vat), country, data_retention_days: days })
      .eq('id', currentOrg.id)
    setBusy(false)
    if (error) return setResult({ ok: false, msg: t(errorKey(error)) })
    setResult({ ok: true, msg: t('common.saved') })
    await refresh()
  }

  return (
    <Panel title={t('settings.orgSection')}>
      <form onSubmit={onSubmit} noValidate className="grid gap-4 sm:grid-cols-2">
        {!isOrgAdmin && (
          <div className="sm:col-span-2">
            <InlineAlert tone="signal">{t('settings.readOnly')}</InlineAlert>
          </div>
        )}
        {result && (
          <div className="sm:col-span-2">
            <InlineAlert tone={result.ok ? 'ok' : 'danger'}>{result.msg}</InlineAlert>
          </div>
        )}
        <Field label={t('settings.orgName')} value={name} onChange={(e) => setName(e.target.value)} error={errors.name} disabled={!isOrgAdmin} maxLength={120} />
        <Field label={t('settings.vat')} value={vat} onChange={(e) => setVat(e.target.value)} error={errors.vat} disabled={!isOrgAdmin} maxLength={20} />
        <Select label={t('settings.country')} value={country} onChange={(e) => setCountry(e.target.value)} disabled={!isOrgAdmin}>
          {COUNTRIES.map((c) => (
            <option key={c.code} value={c.code}>
              {c.name[locale]}
            </option>
          ))}
        </Select>
        <Field
          label={t('settings.retention')}
          type="number"
          inputMode="numeric"
          min={30}
          max={3650}
          value={retention}
          onChange={(e) => setRetention(e.target.value)}
          hint={t('settings.retentionHint')}
          error={errors.retention}
          disabled={!isOrgAdmin}
        />
        {isOrgAdmin && (
          <div className="sm:col-span-2">
            <Button type="submit" loading={busy}>
              {t('common.save')}
            </Button>
          </div>
        )}
      </form>
    </Panel>
  )
}

export default function Settings() {
  const { t } = useI18n()
  return (
    <>
      <PageHeader title={t('settings.title')} />
      <div className="space-y-6">
        <OrganizationForm />
        <div className="grid gap-6 lg:grid-cols-2">
          <TeamPanel />
          <Panel title={t('settings.preferencesSection')}>
            <div className="space-y-4">
              <div>
                <p className="mb-2 text-sm font-medium">{t('settings.theme')}</p>
                <ThemeSegmented />
              </div>
              <div>
                <p className="mb-2 text-sm font-medium">{t('common.language')}</p>
                <LanguageSwitch />
              </div>
            </div>
          </Panel>
        </div>
        <Panel title={t('settings.privacySection')}>
          <p className="max-w-prose text-sm text-muted">{t('settings.privacyBody')}</p>
        </Panel>
        <AccountDeletionPanel />
      </div>
    </>
  )
}
