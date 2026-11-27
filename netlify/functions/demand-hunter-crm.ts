import { handleError, json, readJson, requireMethod } from './_shared/http'
import { authorize } from './_shared/demand-hunter/deps'
import { transferToCrm } from './_shared/demand-hunter/services'
import { crmSchema, parseOr400 } from './_shared/demand-hunter/validation'

/** POST /api/demand-hunter/crm — trasferisce nel CRM i lead selezionati, con deduplicazione. Nessun invio di messaggi. */
export default async (req: Request): Promise<Response> => {
  try {
    requireMethod(req, 'POST')
    const input = parseOr400(crmSchema, await readJson(req, 8_000))
    const { ctx, deps } = await authorize(req, input.organization_id)
    return json(await transferToCrm(deps, ctx, input.lead_ids))
  } catch (err) {
    return handleError(err, '/api/demand-hunter/crm')
  }
}

export const config = { path: '/api/demand-hunter/crm' }
