import { handleError, json, requireMethod, requireUuid } from './_shared/http'
import { requireOrgMember } from './_shared/auth'
import { providerRegistry } from './_shared/campaigns/providers/registry'
import { credentialsKeyStatus } from './_shared/campaigns/crypto'

/**
 * GET /api/communication/providers?organization_id= — provider disponibili e prerequisiti
 * del server. Non espone credenziali: solo se sono configurate.
 */
export default async (req: Request): Promise<Response> => {
  try {
    requireMethod(req, 'GET')
    const orgId = requireUuid(new URL(req.url).searchParams.get('organization_id'), 'organization_id')
    const { db } = await requireOrgMember(req, orgId)
    const { data: accounts } = await db
      .from('communication_accounts')
      .select('id, provider, label, from_name, from_email, reply_to, sending_domain, status, domain_status, dns_records, spf_status, dkim_status, dmarc_status, dmarc_policy, webhook_configured, daily_limit, per_minute_limit, last_checked_at, last_error, connected_at, revoked_at, created_at')
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false })
    const base = (process.env.URL ?? new URL(req.url).origin).replace(/\/$/, '')
    return json({
      server: {
        credentials_key: credentialsKeyStatus(),
        worker_secret: (process.env.LEADFLOW_INTERNAL_SECRET ?? '').length >= 32,
        service_role: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
      },
      providers: Object.values(providerRegistry()).map((p) => ({ id: p.id, label: p.label, implemented: p.implemented, auth: p.auth, docs_url: p.docsUrl, notes: p.notes })),
      accounts: (accounts ?? []).map((a) => ({ ...a, webhook_url: `${base}/api/webhooks/resend/${a.id}` })),
    })
  } catch (err) {
    return handleError(err)
  }
}

export const config = { path: '/api/communication/providers' }
