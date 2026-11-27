import { log } from './_shared/log'
import { demandHunterDeps } from './_shared/demand-hunter/deps'
import { syncJob } from './_shared/demand-hunter/services'
import { SYSTEM_USER } from './_shared/demand-hunter/types'

/**
 * Scheduled function (ogni 5 minuti): sincronizza le cacce in corso anche quando nessuno ha la pagina aperta,
 * così i lead trovati vengono salvati e il budget non usato viene restituito alla fine del job.
 * Non avvia mai nulla e non spende: legge soltanto lo stato dal servizio.
 */
export default async (): Promise<void> => {
  try {
    const deps = demandHunterDeps()
    if (!deps.service || !deps.enabled) return
    const jobs = await deps.store.listActiveJobs(25)
    for (const j of jobs) {
      try {
        await syncJob(deps, { orgId: j.organizationId, userId: j.createdBy ?? SYSTEM_USER }, j.id)
      } catch (err) {
        log('warn', 'demand_hunter.sync_failed', { code: (err as { code?: string })?.code ?? 'error' })
      }
    }
  } catch (err) {
    log('error', 'demand_hunter.sync_tick_failed', { message: (err as Error)?.message?.slice(0, 160) })
  }
}

export const config = { schedule: '*/5 * * * *' }
