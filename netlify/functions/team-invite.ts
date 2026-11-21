import { HttpError, handleError, json, readJson, requireMethod, requireUuid } from './_shared/http'
import { requireOrgMember } from './_shared/auth'
import { supabaseAdmin } from './_shared/supabaseAdmin'
import { rpcHttpError } from './_shared/control/rpc'
import { log } from './_shared/log'
import { sendPlatformEmail } from './_shared/launch/notify'
import { createInvite } from './_shared/team/invite'

/**
 * POST /api/team/invite { organization_id, email, role?, locale? } — solo organization_admin.
 * Revoca, elenco, rimozione e accettazione passano direttamente dalle RPC con il JWT dell'utente
 * (org_revoke_invitation, org_invitations, org_remove_member, accept_team_invitation).
 */
export default async (req: Request): Promise<Response> => {
  try {
    requireMethod(req, 'POST')
    const body = (await readJson(req, 4_000)) as Record<string, unknown>
    const orgId = requireUuid(typeof body?.organization_id === 'string' ? body.organization_id : null, 'organization_id')
    const { user, db } = await requireOrgMember(req, orgId, { admin: true })
    const appUrl = (process.env.APP_URL || process.env.URL || process.env.VITE_APP_URL || '').replace(/\/+$/, '')
    if (!appUrl) throw new HttpError(503, 'server_not_configured')
    const result = await createInvite(
      {
        appUrl,
        async create(email, role) {
          const { data, error } = await db.rpc('org_create_invitation', { p_org: orgId, p_email: email, p_role: role })
          if (error) throw rpcHttpError('org_create_invitation', error)
          return data as { id: string; token: string; expires_at: string; email: string; role: string }
        },
        async context() {
          const [org, prof] = await Promise.all([
            db.from('organizations').select('name').eq('id', orgId).single(),
            db.from('profiles').select('full_name').eq('id', user.id).maybeSingle(),
          ])
          return { organizationName: (org.data as { name?: string } | null)?.name ?? 'LeadFlow AI', inviterName: (prof.data as { full_name?: string | null } | null)?.full_name ?? null }
        },
        send: (to, subject, text) => sendPlatformEmail(to, subject, text),
        async markEmail(id, error) {
          const { error: e } = await supabaseAdmin().rpc('org_invitation_mark_email', { p_invitation: id, p_error: error })
          if (e) log('warn', 'team.invite_mark_failed', {})
        },
      },
      { email: body.email, role: body.role, locale: body.locale },
    )
    log('info', 'team.invited', { email_status: result.email_status })
    return json(result, 201)
  } catch (err) {
    return handleError(err, '/api/team/invite')
  }
}
export const config = { path: '/api/team/invite' }
