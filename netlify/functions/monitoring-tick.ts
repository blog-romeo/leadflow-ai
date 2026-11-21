import { supabaseAdmin } from './_shared/supabaseAdmin'
import { log } from './_shared/log'
import { notifyPlatform } from './_shared/launch/notify'

/**
 * Scheduled function (ogni 15 minuti): valuta le soglie di monitoraggio nel database
 * (webhook Stripe falliti o bloccati, job AI fermi o in errore, automazioni fallite,
 * errori API e browser, costo AI rispetto al budget) e registra gli avvisi (uno per tipo
 * al giorno). Se le notifiche di piattaforma sono configurate, invia un'email interna.
 * Non gira su Deploy Preview e branch deploy (comportamento di Netlify).
 */
export default async (): Promise<void> => {
  try {
    const db = supabaseAdmin()
    const { data, error } = await db.rpc('monitoring_evaluate')
    if (error) throw new Error(error.message)
    type Alert = { kind: string; severity: string; message: string }
    const alerts: Alert[] = [...((data as { new_alerts?: Alert[] })?.new_alerts ?? [])]
    // Prompt 10: avvisi del motore multi-agent (workflow falliti o fermi, verifiche di connessione fallite).
    const ai = await db.rpc('ai_monitoring_evaluate')
    if (ai.error) log('warn', 'monitoring.ai_evaluate_failed', { code: ai.error.code })
    else alerts.push(...((ai.data as { new_alerts?: Alert[] })?.new_alerts ?? []))
    log('info', 'monitoring.tick', { new_alerts: alerts.length })
    if (alerts.length === 0) return
    const r = await notifyPlatform(
      `[LeadFlow AI] ${alerts.some((a) => a.severity === 'critical') ? 'CRITICO' : 'Avviso'}: ${alerts.length} nuovi avvisi di monitoraggio`,
      alerts.map((a) => `[${a.severity.toUpperCase()}] ${a.message}`).join('\n') + '\n\nDettagli: /super-admin/system',
    )
    await db.rpc('monitoring_mark_notified', { p_kinds: alerts.map((a) => a.kind), p_error: r.sent ? null : r.reason })
  } catch (err) {
    log('error', 'monitoring.tick_failed', { message: (err as Error)?.message?.slice(0, 160) })
  }
}

export const config = { schedule: '*/15 * * * *' }
