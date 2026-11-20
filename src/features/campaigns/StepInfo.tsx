import { useState, type FormEvent } from 'react'
import { useI18n } from '../../i18n'
import { supabase } from '../../lib/supabase'
import { CAMPAIGN_GOALS, OUTREACH_CHANNELS, type CampaignGoal, type CampaignRow, type CommunicationAccountRow, type OutreachChannel, type SalesProfileRow } from '../../lib/database.types'
import { Field, Select } from '../../components/ui/Field'
import { Button } from '../../components/ui/Button'
import { InlineAlert } from '../../components/ui/States'
import { Check, cmError, TextArea } from './shared'

const toLocalInput = (iso: string | null) => {
  if (!iso) return ''
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Passo 1: informazioni della campagna (crea la bozza o la aggiorna). */
export function StepInfo({
  orgId,
  campaign,
  profile,
  accounts,
  onSaved,
}: {
  orgId: string
  campaign: CampaignRow | null
  profile: SalesProfileRow | null
  accounts: CommunicationAccountRow[]
  onSaved: (id: string) => void
}) {
  const { t } = useI18n()
  const locked = !!campaign && !['draft', 'pending_approval'].includes(campaign.status)
  const [f, setF] = useState({
    name: campaign?.name ?? '',
    description: campaign?.description ?? '',
    goal: (campaign?.goal ?? 'meeting') as CampaignGoal,
    service_name: campaign?.service_name ?? '',
    language: campaign?.language ?? profile?.language ?? 'it',
    channel: (campaign?.channel ?? 'email') as OutreachChannel,
    planned_start_at: toLocalInput(campaign?.planned_start_at ?? null),
    send_hour_start: campaign?.send_hour_start ?? 9,
    send_hour_end: campaign?.send_hour_end ?? 18,
    weekdays_only: campaign?.weekdays_only ?? true,
    timezone: campaign?.timezone ?? 'Europe/Rome',
    stop_on_appointment: campaign?.stop_on_appointment ?? true,
    account_id: campaign?.account_id ?? '',
    call_to_action: campaign?.call_to_action ?? profile?.call_to_action ?? '',
  })
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }))

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!supabase || locked) return
    if (f.name.trim().length < 2 || f.send_hour_end <= f.send_hour_start) return
    setBusy(true)
    setMsg(null)
    const row = {
      name: f.name.trim(),
      description: f.description.trim() || null,
      goal: f.goal,
      service_name: f.service_name || null,
      language: f.language as 'it' | 'en',
      channel: f.channel,
      planned_start_at: f.planned_start_at ? new Date(f.planned_start_at).toISOString() : null,
      send_hour_start: Number(f.send_hour_start),
      send_hour_end: Number(f.send_hour_end),
      weekdays_only: f.weekdays_only,
      timezone: f.timezone.trim() || 'Europe/Rome',
      stop_on_appointment: f.stop_on_appointment,
      account_id: f.channel === 'email' && f.account_id ? f.account_id : null,
      call_to_action: f.call_to_action.trim() || null,
    }
    const res = campaign
      ? await supabase.from('campaigns').update(row).eq('id', campaign.id).select('id').single()
      : await supabase.from('campaigns').insert({ organization_id: orgId, ...row }).select('id').single()
    setBusy(false)
    if (res.error) return setMsg({ ok: false, text: cmError(res.error, t) })
    setMsg({ ok: true, text: t('cm.info.saved') })
    onSaved(res.data.id as string)
  }

  const hours = Array.from({ length: 25 }, (_, i) => i)
  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-5" noValidate>
      {locked && <InlineAlert tone="signal">{t('cm.info.locked')}</InlineAlert>}
      <fieldset disabled={locked} className="space-y-5">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label={t('cm.info.name')} value={f.name} onChange={(e) => set('name', e.target.value)} maxLength={160} required error={f.name && f.name.trim().length < 2 ? t('cm.info.nameShort') : null} />
          <Select label={t('cm.info.goal')} value={f.goal} onChange={(e) => set('goal', e.target.value as CampaignGoal)}>
            {CAMPAIGN_GOALS.map((g) => (
              <option key={g} value={g}>
                {t(`cm.goals.${g}`)}
              </option>
            ))}
          </Select>
        </div>
        <TextArea id="cm-desc" label={t('cm.info.description')} value={f.description} onChange={(v) => set('description', v)} rows={3} maxLength={4000} />
        <div className="grid gap-4 md:grid-cols-3">
          <Select label={t('cm.info.service')} value={f.service_name} onChange={(e) => set('service_name', e.target.value)}>
            <option value="">{t('cm.info.serviceNone')}</option>
            {(profile?.services ?? []).map((s) => (
              <option key={s.id} value={s.name}>
                {s.name}
              </option>
            ))}
          </Select>
          <Select label={t('cm.info.language')} value={f.language} onChange={(e) => set('language', e.target.value as 'it' | 'en')}>
            <option value="it">Italiano</option>
            <option value="en">English</option>
          </Select>
          <Select label={t('cm.info.channel')} value={f.channel} onChange={(e) => set('channel', e.target.value as OutreachChannel)}>
            {OUTREACH_CHANNELS.map((c) => (
              <option key={c} value={c}>
                {t(`cm.channels.${c}`)}
              </option>
            ))}
          </Select>
        </div>
        {f.channel !== 'email' && <p className="text-sm text-muted">{t('cm.info.channelManual')}</p>}
        {f.channel === 'email' && (
          <Select label={t('cm.info.account')} value={f.account_id} onChange={(e) => set('account_id', e.target.value)}>
            <option value="">{t('cm.info.accountNone')}</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label} · {a.from_email} ({t(`channels.status.${a.status}`)})
              </option>
            ))}
          </Select>
        )}
        <Field label={t('cm.info.cta')} value={f.call_to_action} onChange={(e) => set('call_to_action', e.target.value)} maxLength={300} />
        <fieldset className="space-y-3 rounded-[var(--radius-panel)] border border-line p-4">
          <legend className="px-1 text-sm font-medium">{t('cm.info.window')}</legend>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field type="datetime-local" label={t('cm.info.plannedStart')} hint={t('cm.info.plannedStartHint')} value={f.planned_start_at} onChange={(e) => set('planned_start_at', e.target.value)} />
            <Select label={t('cm.info.hourStart')} value={String(f.send_hour_start)} onChange={(e) => set('send_hour_start', Number(e.target.value))}>
              {hours.slice(0, 24).map((h) => (
                <option key={h} value={h}>{`${String(h).padStart(2, '0')}:00`}</option>
              ))}
            </Select>
            <Select label={t('cm.info.hourEnd')} value={String(f.send_hour_end)} onChange={(e) => set('send_hour_end', Number(e.target.value))}>
              {hours.slice(1).map((h) => (
                <option key={h} value={h}>{`${String(h).padStart(2, '0')}:00`}</option>
              ))}
            </Select>
            <Field label={t('cm.info.timezone')} value={f.timezone} onChange={(e) => set('timezone', e.target.value)} maxLength={60} />
          </div>
          <Check id="cm-weekdays" label={t('cm.info.weekdays')} checked={f.weekdays_only} onChange={(v) => set('weekdays_only', v)} />
          <Check id="cm-stop-appt" label={t('cm.info.stopOnAppointment')} checked={f.stop_on_appointment} onChange={(v) => set('stop_on_appointment', v)} />
        </fieldset>
      </fieldset>
      <div aria-live="polite" className="empty:hidden">
        {msg && <InlineAlert tone={msg.ok ? 'ok' : 'danger'}>{msg.text}</InlineAlert>}
      </div>
      {!locked && (
        <Button type="submit" loading={busy} disabled={f.name.trim().length < 2 || f.send_hour_end <= f.send_hour_start}>
          {campaign ? t('cm.info.save') : t('cm.info.create')}
        </Button>
      )}
    </form>
  )
}
