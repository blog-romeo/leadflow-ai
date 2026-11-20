import { handleError, json, readJson, requireMethod } from './_shared/http'
import { requireOrgMember } from './_shared/auth'
import { parseOr400 } from './_shared/lead-finder/validation'
import { accountActionSchema } from './_shared/campaigns/validation'
import { connectAccount, refreshAccount, revokeAccount, setWebhookSecret } from './_shared/campaigns/accounts'
import { campaignDeps } from './_shared/campaigns/deps'

/**
 * POST /api/communication/accounts — collegamento, verifica dominio, segreto webhook,
 * limiti e revoca di un provider email. Solo organization_admin. Le credenziali non
 * vengono mai restituite al client.
 */
export default async (req: Request): Promise<Response> => {
  try {
    requireMethod(req, 'POST')
    const input = parseOr400(accountActionSchema, await readJson(req, 8_000))
    const { user } = await requireOrgMember(req, input.organization_id, { admin: true })
    const deps = campaignDeps()
    const ctx = { orgId: input.organization_id, userId: user.id }
    switch (input.action) {
      case 'create': {
        const account = await connectAccount(deps, ctx, input)
        return json({ account }, 201)
      }
      case 'refresh':
        return json({ account: await refreshAccount(deps, ctx, input.account_id, { requestVerification: input.request_verification }) })
      case 'webhook_secret':
        await setWebhookSecret(deps, ctx, input.account_id, input.secret)
        return json({ ok: true })
      case 'limits':
        await deps.accounts.updateAccount(ctx.orgId, input.account_id, { daily_limit: input.daily_limit, per_minute_limit: input.per_minute_limit })
        return json({ ok: true })
      case 'revoke':
        await revokeAccount(deps, ctx, input.account_id)
        return json({ ok: true })
    }
  } catch (err) {
    return handleError(err)
  }
}

export const config = { path: '/api/communication/accounts' }
