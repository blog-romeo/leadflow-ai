import { useEffect, useState, type FormEvent } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import { useI18n } from '../../i18n'
import { supabase } from '../../lib/supabase'
import type { OrgRole, ProfileRow } from '../../lib/database.types'
import { normalizeVat, validateOrganizationName, validateRetentionDays, validateVatNumber } from '../../lib/validation'
import { errorKey } from '../../lib/errors'
import { COUNTRIES } from '../../config/countries'
import { PageHeader } from '../../components/ui/PageHeader'
import { Panel } from '../../components/ui/Panel'
import { Field, Select } from '../../components/ui/Field'
import { Button } from '../../components/ui/Button'
import { Badge } from '../../components/ui/Badge'
import { ErrorState, InlineAlert, LoadingState } from '../../components/ui/States'
import { LanguageSwitch, ThemeSegmented } from '../../components/ui/Preferences'

interface MemberView {
  user_id: string
  role: OrgRole
  profile: Pick<ProfileRow, 'full_name' | 'email'> | null
}

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

function Members() {
  const { t } = useI18n()
  const { currentOrg, user } = useAuth()
  const [members, setMembers] = useState<MemberView[] | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    const db = supabase
    if (!db || !currentOrg) return
    let active = true
    ;(async () => {
      const { data: rows, error: e1 } = await db.from('organization_members').select('user_id, role').eq('organization_id', currentOrg.id)
      if (e1 || !rows) return active && setError(true)
      const ids = rows.map((r) => r.user_id)
      const { data: profiles, error: e2 } = await db.from('profiles').select('id, full_name, email').in('id', ids)
      if (e2) return active && setError(true)
      if (!active) return
      setMembers(rows.map((r) => ({ ...r, profile: profiles?.find((p) => p.id === r.user_id) ?? null })))
    })()
    return () => {
      active = false
    }
  }, [currentOrg])

  return (
    <Panel title={t('settings.membersSection')}>
      {error ? (
        <ErrorState message={t('errors.generic')} />
      ) : !members ? (
        <LoadingState />
      ) : (
        <>
          <ul className="divide-y divide-line">
            {members.map((m) => (
              <li key={m.user_id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {m.profile?.full_name ?? m.profile?.email}
                    {m.user_id === user?.id && <span className="text-muted"> ({t('settings.you')})</span>}
                  </p>
                  {m.profile?.full_name && <p className="truncate text-xs text-muted">{m.profile.email}</p>}
                </div>
                <Badge tone={m.role === 'organization_admin' ? 'flow' : 'neutral'}>{t(`roles.${m.role}`)}</Badge>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-muted">{t('settings.membersInvite')}</p>
        </>
      )}
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
          <Members />
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
      </div>
    </>
  )
}
