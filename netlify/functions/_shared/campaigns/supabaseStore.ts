import type { SupabaseClient } from '@supabase/supabase-js'
import { HttpError } from '../http'
import { log } from '../log'
import type { AccountsDb, AutomationJob, BeginSend, CampaignStore, LeadBrief, StepContext } from './store'

/**
 * Implementazione con service role. Usata SOLO dal worker, dai webhook firmati e dagli
 * endpoint dopo la verifica di utente, organizzazione e ruolo. Ogni query filtra per id
 * e, dove applicabile, per organization_id.
 */
function fail(op: string, error: { message?: string; code?: string }): never {
  log('error', 'campaign_store.error', { op, code: error.code, message: error.message?.slice(0, 160) })
  if (error.code === 'P0001' || error.code === '22023' || error.code === '23514') throw new HttpError(409, (error.message ?? 'conflict').split(':')[0]!.slice(0, 80))
  throw new HttpError(500, 'database_error')
}

const LEAD_COLS = 'id, company_name, status, contact_status, score, industry, country, email'

export function createCampaignStore(db: SupabaseClient): CampaignStore {
  return {
    async scheduleDueSteps(limit) {
      const { data, error } = await db.rpc('schedule_due_steps', { p_limit: limit })
      if (error) fail('schedule_due_steps', error)
      return Number(data ?? 0)
    },
    async claimJobs(worker, limit, lease) {
      const { data, error } = await db.rpc('claim_automation_jobs', { p_worker: worker, p_limit: limit, p_lease_seconds: lease })
      if (error) fail('claim_automation_jobs', error)
      return (data ?? []) as AutomationJob[]
    },
    async finishJob(id, outcome, err, retry) {
      const { error } = await db.rpc('finish_automation_job', { p_job: id, p_outcome: outcome, p_error: err ?? null, p_retry_seconds: retry ?? null })
      if (error) fail('finish_automation_job', error)
    },
    async deferJob(id, seconds) {
      const { error } = await db.rpc('defer_automation_job', { p_job: id, p_seconds: Math.round(seconds) })
      if (error) fail('defer_automation_job', error)
    },
    async enqueueJob(row) {
      const { data, error } = await db
        .from('automation_jobs')
        .upsert(
          {
            organization_id: row.org,
            kind: row.kind,
            idempotency_key: row.key,
            payload: row.payload,
            campaign_id: row.campaignId ?? null,
            workflow_id: row.workflowId ?? null,
            max_attempts: row.maxAttempts ?? 5,
          },
          { onConflict: 'organization_id,idempotency_key', ignoreDuplicates: true },
        )
        .select('id')
      if (error) fail('enqueue_job', error)
      return (data?.[0]?.id as string | undefined) ?? null
    },
    async countDueJobs() {
      const { count, error } = await db
        .from('automation_jobs')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'queued')
        .lte('run_at', new Date().toISOString())
      if (error) fail('count_due_jobs', error)
      return count ?? 0
    },

    async getStepContext(recipientId, stepId) {
      const { data: r, error } = await db
        .from('campaign_recipients')
        .select('id, organization_id, campaign_id, lead_id, status, campaign:campaigns(status, name, timezone, send_hour_start, send_hour_end, weekdays_only, activated_by, language)')
        .eq('id', recipientId)
        .maybeSingle()
      if (error) fail('get_recipient', error)
      if (!r) return null
      const { data: st, error: e2 } = await db.from('campaign_steps').select('id, kind, position, day_offset').eq('id', stepId).eq('organization_id', r.organization_id).maybeSingle()
      if (e2) fail('get_step', e2)
      if (!st) return null
      const campaign = (Array.isArray(r.campaign) ? r.campaign[0] : r.campaign) as StepContext['campaign']
      return { recipient: { id: r.id, organization_id: r.organization_id, campaign_id: r.campaign_id, lead_id: r.lead_id, status: r.status }, step: st as StepContext['step'], campaign }
    },
    async prepareStepMessage(recipientId, stepId) {
      const { data, error } = await db.rpc('prepare_step_message', { p_recipient: recipientId, p_step: stepId })
      if (error) fail('prepare_step_message', error)
      const m = (Array.isArray(data) ? data[0] : data) as { id: string; status: string }
      return { id: m.id, status: m.status }
    },
    async beginSend(messageId) {
      const { data, error } = await db.rpc('begin_send', { p_message: messageId })
      if (error) fail('begin_send', error)
      return data as BeginSend
    },
    async finishSend(messageId, outcome, providerId, err) {
      const { error } = await db.rpc('finish_send', { p_message: messageId, p_outcome: outcome, p_provider_id: providerId ?? null, p_error: err ?? null })
      if (error) fail('finish_send', error)
    },
    async advanceRecipient(recipientId, position) {
      const { error } = await db.rpc('advance_recipient', { p_recipient: recipientId, p_position: position })
      if (error) fail('advance_recipient', error)
    },
    async stopRecipient(recipientId, reason) {
      const { error } = await db.rpc('stop_recipient', { p_recipient: recipientId, p_reason: reason })
      if (error) fail('stop_recipient', error)
    },

    async getAccount(org, accountId) {
      let q = db.from('communication_accounts').select('id, organization_id, provider, status, from_email, sending_domain, provider_domain_id, webhook_configured').eq('id', accountId)
      if (org) q = q.eq('organization_id', org)
      const { data, error } = await q.maybeSingle()
      if (error) fail('get_account', error)
      return data
    },
    async getAccountSecrets(accountId) {
      const { data, error } = await db.from('communication_account_secrets').select('api_key_ciphertext, webhook_secret_ciphertext').eq('account_id', accountId).maybeSingle()
      if (error) fail('get_account_secrets', error)
      return data
    },
    async setAccountStatus(accountId, patch) {
      const { error } = await db.from('communication_accounts').update(patch).eq('id', accountId)
      if (error) fail('set_account_status', error)
    },
    async getSenderIdentity(org) {
      const { data, error } = await db
        .from('sales_profiles')
        .select('sender_legal_name, sender_address, privacy_policy_url, email_signature')
        .eq('organization_id', org)
        .maybeSingle()
      if (error) fail('get_sender', error)
      if (!data?.sender_legal_name || !data.sender_address || !data.privacy_policy_url) return null
      return { legalName: data.sender_legal_name, address: data.sender_address, privacyUrl: data.privacy_policy_url, signature: data.email_signature ?? null }
    },

    async createTask(row) {
      const { data, error } = await db
        .from('follow_up_tasks')
        .insert({
          organization_id: row.org,
          lead_id: row.leadId,
          kind: row.kind,
          title: row.title,
          notes: row.notes,
          due_at: row.dueAt,
          source: row.source,
          campaign_recipient_id: row.recipientId ?? null,
          automation_job_id: row.jobId ?? null,
          assigned_to: row.assignedTo ?? null,
        })
        .select('id')
        .maybeSingle()
      if (error) {
        if (error.code === '23505') return null // già creato da un tentativo precedente
        fail('create_task', error)
      }
      return (data?.id as string | undefined) ?? null
    },
    async notify(org, userId, title, body, link) {
      const { error } = await db.from('notifications').insert({ organization_id: org, user_id: userId, title: title.slice(0, 200), body: body?.slice(0, 1000) ?? null, link })
      if (error) fail('notify', error)
    },
    async logActivity(org, leadId, subject, metadata) {
      const { error } = await db.from('activities').insert({ organization_id: org, lead_id: leadId, type: 'system', subject: subject.slice(0, 300), metadata })
      if (error) fail('log_activity', error)
    },
    async updateLeadStatus(org, leadId, status) {
      const { error } = await db.from('leads').update({ status }).eq('organization_id', org).eq('id', leadId)
      if (error) fail('update_lead_status', error)
    },
    async getLead(org, leadId) {
      const { data, error } = await db.from('leads').select(LEAD_COLS).eq('organization_id', org).eq('id', leadId).is('deleted_at', null).maybeSingle()
      if (error) fail('get_lead', error)
      return data as LeadBrief | null
    },

    async fetchPendingEvents(limit) {
      const { data, error } = await db
        .from('automation_events')
        .select('id, organization_id, type, lead_id, campaign_id, entity_type, entity_id, payload')
        .is('processed_at', null)
        .order('id')
        .limit(limit)
      if (error) fail('fetch_events', error)
      return data ?? []
    },
    async markEventsProcessed(ids) {
      if (!ids.length) return
      const { error } = await db.from('automation_events').update({ processed_at: new Date().toISOString() }).in('id', ids)
      if (error) fail('mark_events', error)
    },
    async runningWorkflows(org, trigger) {
      const { data, error } = await db
        .from('automation_workflows')
        .select('id, organization_id, name, trigger, conditions, actions, approved_by')
        .eq('organization_id', org)
        .eq('trigger', trigger)
        .eq('status', 'running')
      if (error) fail('running_workflows', error)
      return data ?? []
    },
    async recordWorkflowRun(id, err) {
      const { data } = await db.from('automation_workflows').select('run_count').eq('id', id).maybeSingle()
      const { error } = await db
        .from('automation_workflows')
        .update({ run_count: (data?.run_count ?? 0) + 1, last_run_at: new Date().toISOString(), last_error: err })
        .eq('id', id)
      if (error) fail('record_workflow_run', error)
    },
    async getWorkflow(id) {
      const { data, error } = await db.from('automation_workflows').select('id, organization_id, name, trigger, conditions, actions, approved_by, status').eq('id', id).maybeSingle()
      if (error) fail('get_workflow', error)
      return data
    },

    async findLeadByEmail(org, email) {
      const { data, error } = await db.from('leads').select(LEAD_COLS).eq('organization_id', org).ilike('email', email.replace(/[%_\\]/g, '\\$&')).is('deleted_at', null).limit(1)
      if (error) fail('find_lead_by_email', error)
      return (data?.[0] as LeadBrief | undefined) ?? null
    },
    async latestOutboundTo(accountId, email) {
      const { data, error } = await db
        .from('outbound_messages')
        .select('id, recipient_id, lead_id')
        .eq('account_id', accountId)
        .ilike('to_email', email.replace(/[%_\\]/g, '\\$&'))
        .in('kind', ['campaign', 'reply'])
        .not('sent_at', 'is', null)
        .order('sent_at', { ascending: false })
        .limit(1)
      if (error) fail('latest_outbound', error)
      return data?.[0] ?? null
    },
    async insertInbound(row) {
      const { data, error } = await db.from('inbound_messages').insert(row).select('id').maybeSingle()
      if (error) {
        if (error.code === '23505') {
          const { data: ex } = await db.from('inbound_messages').select('id').eq('account_id', row.account_id).eq('provider_message_id', row.provider_message_id).maybeSingle()
          return { id: ex?.id as string, duplicate: true }
        }
        fail('insert_inbound', error)
      }
      return { id: data!.id as string, duplicate: false }
    },
    async createOutbound(row) {
      const { data, error } = await db
        .from('outbound_messages')
        .insert({
          organization_id: row.org,
          kind: row.kind,
          account_id: row.accountId,
          lead_id: row.leadId,
          in_reply_to: row.inReplyTo,
          to_email: row.to,
          subject: row.subject,
          body_text: row.body,
          idempotency_key: row.idempotencyKey,
          confirmed_by: row.confirmedBy,
        })
        .select('id')
        .maybeSingle()
      if (error) {
        if (error.code === '23505') {
          const { data: ex } = await db.from('outbound_messages').select('id').eq('idempotency_key', row.idempotencyKey).eq('organization_id', row.org).maybeSingle()
          if (ex) return { id: ex.id as string, duplicate: true }
        }
        fail('create_outbound', error)
      }
      return { id: data!.id as string, duplicate: false }
    },
    async applyDeliveryEvent(accountId, eventId, type, providerMessageId, occurredAt, detail) {
      const { error } = await db.rpc('apply_delivery_event', {
        p_account: accountId,
        p_provider: 'resend',
        p_event_id: eventId,
        p_type: type,
        p_provider_message_id: providerMessageId,
        p_occurred_at: occurredAt,
        p_detail: detail,
      })
      if (error) fail('apply_delivery_event', error)
    },
    async registerUnsubscribe(messageId) {
      const { data, error } = await db.rpc('register_unsubscribe', { p_message: messageId })
      if (error) fail('register_unsubscribe', error)
      return Boolean((data as { ok?: boolean } | null)?.ok)
    },
  }
}

export function createAccountsDb(db: SupabaseClient): AccountsDb {
  return {
    async insertAccount(row) {
      const { data, error } = await db.from('communication_accounts').insert(row).select('id').single()
      if (error) {
        if (error.code === '23505') throw new HttpError(409, 'account_already_exists')
        if (error.code === '23514') throw new HttpError(400, 'invalid_sender')
        fail('insert_account', error)
      }
      return data.id as string
    },
    async updateAccount(org, id, patch) {
      const { error } = await db.from('communication_accounts').update(patch).eq('organization_id', org).eq('id', id)
      if (error) fail('update_account', error)
    },
    async getAccountFull(org, id) {
      const { data, error } = await db
        .from('communication_accounts')
        .select('id, organization_id, provider, status, from_email, sending_domain, provider_domain_id, webhook_configured, domain_status, dns_records, label')
        .eq('organization_id', org)
        .eq('id', id)
        .maybeSingle()
      if (error) fail('get_account_full', error)
      return data
    },
    async upsertSecrets(accountId, org, patch) {
      const { error } = await db
        .from('communication_account_secrets')
        .upsert({ account_id: accountId, organization_id: org, ...patch, updated_at: new Date().toISOString() }, { onConflict: 'account_id' })
      if (error) fail('upsert_secrets', error)
    },
    async deleteSecrets(accountId) {
      const { error } = await db.from('communication_account_secrets').delete().eq('account_id', accountId)
      if (error) fail('delete_secrets', error)
    },
    async memberEmails(org) {
      const { data, error } = await db.from('organization_members').select('user_id').eq('organization_id', org)
      if (error) fail('member_ids', error)
      const ids = (data ?? []).map((r) => r.user_id as string)
      if (!ids.length) return []
      const { data: profiles, error: e2 } = await db.from('profiles').select('email').in('id', ids)
      if (e2) fail('member_emails', e2)
      return (profiles ?? []).map((p) => String(p.email ?? '').toLowerCase()).filter(Boolean)
    },
  }
}
