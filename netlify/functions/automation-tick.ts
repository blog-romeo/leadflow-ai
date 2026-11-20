import { campaignDeps, dispatchWorker } from './_shared/campaigns/deps'
import { tick } from './_shared/campaigns/worker'
import { log } from './_shared/log'

/**
 * Scheduled function (ogni minuto, limite 30 s): attiva le campagne programmate, crea i job
 * degli step in scadenza, smista gli eventi verso i workflow e, se ci sono job pronti,
 * avvia il worker in background (fino a 15 minuti).
 * Non gira su Deploy Preview e branch deploy (comportamento di Netlify).
 */
export default async (): Promise<void> => {
  try {
    const r = await tick(campaignDeps())
    if (r.due > 0) await dispatchWorker()
    log('info', 'automation.tick', r)
  } catch (err) {
    log('error', 'automation.tick_failed', { message: (err as Error)?.message?.slice(0, 160) })
  }
}

export const config = { schedule: '* * * * *' }
