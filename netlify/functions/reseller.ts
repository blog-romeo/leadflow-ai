import { supabaseUrl } from './_shared/env'
import { randomBytes } from 'node:crypto'
import { HttpError, handleError, json, readJson } from './_shared/http'
import { requireUser } from './_shared/auth'
import { log } from './_shared/log'
import { supabaseAdmin } from './_shared/supabaseAdmin'
import { requireResellerMember } from './_shared/control/roles'
import { rpc } from './_shared/control/rpc'
import { obj, oneOf, str, uuid } from './_shared/control/validate'
import { checkDomain, DomainError, normalizeHostname } from './_shared/control/domains'
import { liveDnsDeps } from './_shared/control/liveDns'
import { decodeBase64, ImageError, LIMITS, validateImage, type AssetKind } from './_shared/control/images'
import { assetUrl } from './_shared/control/tenant'
import { billingDeps } from './_shared/billing/deps'
import { openResellerPortal, startResellerCheckout } from './_shared/billing/service'

/**
 * /api/reseller/<azione> — portale rivenditori. Ogni azione verifica l'appartenenza al
 * rivenditore indicato (e il ruolo reseller_admin per le modifiche); le RPC ricontrollano
 * ruolo, stato, abbonamento White Label, limiti del piano, feature flag e rate limit.
 * Un rivenditore non accede mai ai dati di clienti di altri rivenditori né ai dati commerciali
 * dei propri clienti (solo metadati e consumi aggregati).
 */
const appUrl = () => (process.env.APP_URL || process.env.URL || '').replace(/\/+$/, '')
const platformHosts = () => [process.env.URL, process.env.APP_URL, process.env.DEPLOY_PRIME_URL]
  .filter((u): u is string => !!u)
  .map((u) => { try { return new URL(u).hostname } catch { return '' } })
  .filter(Boolean)

function withAssetUrls(dashboard: Record<string, unknown>) {
  const b = dashboard.branding as Record<string, unknown> | null
  if (!b) return dashboard
  const base = supabaseUrl()
  return { ...dashboard, branding: { ...b, logo_url: assetUrl(base, b.logo_path), login_logo_url: assetUrl(base, b.login_logo_path), favicon_url: assetUrl(base, b.favicon_path) } }
}

async function uploadAsset(resellerId: string, userId: string, body: Record<string, unknown>) {
  const kind = oneOf(body.kind, 'kind', ['logo', 'login_logo', 'favicon'] as const) as AssetKind
  const admin = supabaseAdmin()
  const { data: current } = await admin.from('reseller_branding').select('logo_path, login_logo_path, favicon_path').eq('reseller_id', resellerId).maybeSingle()
  const oldPath = (current as Record<string, string | null> | null)?.[`${kind}_path`] ?? null

  let newPath: string | null = null
  if (body.remove !== true) {
    let image
    try {
      const bytes = decodeBase64(str(body.data_base64, 'data_base64', 8, 1_000_000), LIMITS[kind].maxBytes)
      image = validateImage(bytes, str(body.content_type, 'content_type', 5, 60), kind)
      newPath = `${resellerId}/${kind}-${randomBytes(6).toString('hex')}.${image.type}`
      // Nome generato dal server: nessun nome di file del client finisce nello storage.
      const { error } = await admin.storage.from('branding').upload(newPath, bytes, { contentType: image.mime, upsert: false, cacheControl: '31536000' })
      if (error) {
        log('error', 'branding.upload_failed', { kind })
        throw new HttpError(502, 'storage_upload_failed')
      }
    } catch (err) {
      if (err instanceof ImageError) throw new HttpError(400, `image_${err.code}`)
      throw err
    }
  }
  await rpc(admin, 'reseller_set_branding_asset', { p_reseller: resellerId, p_kind: kind, p_path: newPath, p_actor: userId })
  if (oldPath) await admin.storage.from('branding').remove([oldPath]).catch(() => undefined)
  return { kind, url: assetUrl(supabaseUrl(), newPath) }
}

type Ctx = Awaited<ReturnType<typeof requireResellerMember>>

const POST: Record<string, { admin: boolean; run: (c: Ctx, resellerId: string, b: Record<string, unknown>) => Promise<unknown> }> = {
  'invitation-create': {
    admin: true,
    async run({ db }, resellerId, b) {
      const r = await rpc<{ id: string; token: string; expires_at: string }>(db, 'reseller_create_invitation', {
        p_reseller: resellerId,
        p_email: str(b.email, 'email', 3, 254),
        p_org_name: str(b.organization_name, 'organization_name', 2, 120),
        p_client_plan: oneOf(b.client_plan_code, 'client_plan_code', ['starter', 'business', 'enterprise'] as const),
      })
      // L'invio email automatico non è attivo: il rivenditore condivide il link (valido 14 giorni, una sola volta).
      return { id: r.id, expires_at: r.expires_at, invite_url: `${appUrl()}/invite?token=${r.token}`, email_sent: false }
    },
  },
  'invitation-revoke': { admin: true, run: ({ db }, resellerId, b) => rpc(db, 'reseller_revoke_invitation', { p_reseller: resellerId, p_invitation: uuid(b.invitation_id, 'invitation_id') }) },
  'client-plan': {
    admin: true,
    run: ({ db }, resellerId, b) =>
      rpc(db, 'reseller_set_client_plan', { p_reseller: resellerId, p_org: uuid(b.organization_id, 'organization_id'), p_client_plan: oneOf(b.client_plan_code, 'client_plan_code', ['starter', 'business', 'enterprise'] as const) }),
  },
  branding: { admin: true, run: ({ db }, resellerId, b) => rpc(db, 'reseller_update_branding', { p_reseller: resellerId, p_patch: obj(b.patch, 'patch') }) },
  'branding-asset': {
    admin: true,
    async run({ db, user }, resellerId, b) {
      await rpc(db, 'reseller_can_upload_branding', { p_reseller: resellerId })
      return uploadAsset(resellerId, user.id, b)
    },
  },
  'domain-add': {
    admin: true,
    async run({ db }, resellerId, b) {
      let host: string
      try {
        host = normalizeHostname(str(b.hostname, 'hostname', 4, 253), { platformHosts: platformHosts() })
      } catch (err) {
        if (err instanceof DomainError) throw new HttpError(400, err.code)
        throw err
      }
      return rpc(db, 'reseller_add_domain', { p_reseller: resellerId, p_hostname: host })
    },
  },
  'domain-remove': { admin: true, run: ({ db }, resellerId, b) => rpc(db, 'reseller_remove_domain', { p_reseller: resellerId, p_domain: uuid(b.domain_id, 'domain_id') }) },
  'domain-verify': {
    admin: true,
    async run({ db }, resellerId, b) {
      const d = await rpc<{ id: string; hostname: string; verification_token: string; provisioning: string; cname_target: string | null }>(db, 'reseller_domain_for_check', {
        p_reseller: resellerId,
        p_domain: uuid(b.domain_id, 'domain_id'),
      })
      const result = await checkDomain({ hostname: d.hostname, token: d.verification_token, cnameTarget: d.cname_target, provisioned: d.provisioning === 'manual_done' }, liveDnsDeps())
      return rpc(supabaseAdmin(), 'domain_record_check', { p_domain: d.id, p_txt_ok: result.txtOk, p_dns_status: result.dnsStatus, p_https_status: result.httpsStatus, p_error: result.error })
    },
  },
  'billing-checkout': {
    admin: true,
    async run({ db, user }, resellerId) {
      await rpc(db, 'reseller_billing_context', { p_reseller: resellerId })
      return startResellerCheckout(billingDeps(), { resellerId, userId: user.id, email: user.email ?? null })
    },
  },
  'billing-portal': {
    admin: true,
    async run({ db, user }, resellerId) {
      await rpc(db, 'reseller_billing_context', { p_reseller: resellerId })
      return openResellerPortal(billingDeps(), { resellerId, userId: user.id, email: user.email ?? null })
    },
  },
}

export default async (req: Request): Promise<Response> => {
  try {
    const url = new URL(req.url)
    const action = url.pathname.replace(/^\/api\/reseller\/?/, '')
    if (req.method === 'GET') {
      if (action === 'me') {
        const { db } = await requireUser(req)
        return json({ resellers: await rpc(db, 'reseller_my_resellers') })
      }
      if (action === 'dashboard') {
        const resellerId = uuid(url.searchParams.get('reseller_id'), 'reseller_id')
        const { db } = await requireResellerMember(req, resellerId)
        return json(withAssetUrls(await rpc<Record<string, unknown>>(db, 'reseller_dashboard', { p_reseller: resellerId })))
      }
      throw new HttpError(404, 'unknown_action')
    }
    if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { allow: 'GET, POST' })
    const spec = Object.hasOwn(POST, action) ? POST[action] : undefined
    if (!spec) throw new HttpError(404, 'unknown_action')
    const body = obj(await readJson(req, 1_200_000), 'body')
    const resellerId = uuid(body.reseller_id, 'reseller_id')
    const ctx = await requireResellerMember(req, resellerId, { admin: spec.admin })
    return json((await spec.run(ctx, resellerId, body)) ?? { ok: true })
  } catch (err) {
    return handleError(err)
  }
}
export const config = { path: '/api/reseller/*' }
