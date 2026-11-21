import { supabaseAdmin } from './_shared/supabaseAdmin'
import { log } from './_shared/log'

/**
 * Scheduled function (ogni giorno alle 03:15 UTC): applica la conservazione dei dati configurata da
 * ogni organizzazione (lead inattivi oltre data_retention_days, lead eliminati da oltre 30 giorni,
 * candidati non salvati da oltre 90 giorni). ELIMINA DATI: esegue solo se RETENTION_PURGE_ENABLED=true.
 * In alternativa si può usare pg_cron su Supabase (README → Conservazione): non attivarli entrambi.
 */
export default async (): Promise<void> => {
  if (process.env.RETENTION_PURGE_ENABLED !== 'true') {
    log('info', 'retention.disabled', {})
    return
  }
  try {
    const { data, error } = await supabaseAdmin().rpc('run_retention_purge')
    if (error) throw new Error(error.message)
    log('info', 'retention.purged', data as Record<string, unknown>)
  } catch (err) {
    log('error', 'retention.failed', { message: (err as Error)?.message?.slice(0, 160) })
  }
}

export const config = { schedule: '15 3 * * *' }
