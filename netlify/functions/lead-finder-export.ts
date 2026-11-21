import { handleError, requireMethod, requireUuid } from './_shared/http'
import { requireOrgMember } from './_shared/auth'
import { exportCandidatesCsv } from './_shared/lead-finder/services'
import { leadFinderDeps } from './_shared/lead-finder/deps'
import { requireFeature } from './_shared/billing/access'
import { billingGate } from './_shared/billing/deps'

/** GET /api/lead-finder/export?organization_id=&search_id= — CSV dei soli dati esportabili per licenza. */
export default async (req: Request): Promise<Response> => {
  try {
    requireMethod(req, 'GET')
    const params = new URL(req.url).searchParams
    const orgId = requireUuid(params.get('organization_id'), 'organization_id')
    const searchId = params.get('search_id') ? requireUuid(params.get('search_id'), 'search_id') : null
    const { user } = await requireOrgMember(req, orgId)
    // Controllo di piano lato server (402 se la funzionalità non è inclusa o l'abbonamento non è attivo).
    await requireFeature(billingGate(), orgId, 'export')
    const { store } = leadFinderDeps()
    const { csv } = await exportCandidatesCsv({ store }, { orgId, userId: user.id }, searchId)
    return new Response('﻿' + csv, {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="leadflow-lead-${new Date().toISOString().slice(0, 10)}.csv"`,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    })
  } catch (err) {
    return handleError(err)
  }
}

export const config = { path: '/api/lead-finder/export' }
