import { HttpError, readJson, requireMethod, requireUuid } from '../http'
import { requireOrgMember } from '../auth'
import type { BillingCtx } from './service'
import { PLAN_CODES } from './config'

/** POST con organization_id: solo admin dell'organizzazione possono gestire il billing. */
export async function billingAdminRequest(req: Request): Promise<{ ctx: BillingCtx; body: Record<string, unknown> }> {
  requireMethod(req, 'POST')
  const body = (await readJson(req, 4_000)) as Record<string, unknown>
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'invalid_body')
  const orgId = requireUuid(typeof body.organization_id === 'string' ? body.organization_id : null, 'organization_id')
  const { user } = await requireOrgMember(req, orgId, { admin: true })
  return { ctx: { orgId, userId: user.id, email: user.email ?? null }, body }
}

export function requirePlanCode(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_]{1,30}$/.test(value)) throw new HttpError(400, 'invalid_plan')
  return value
}

export { PLAN_CODES }
