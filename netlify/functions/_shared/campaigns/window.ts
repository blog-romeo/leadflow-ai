/**
 * Finestra di invio della campagna (es. 9–18, lun–ven, fuso Europe/Rome).
 * Restituisce 0 se si può inviare ora, altrimenti i secondi fino all'apertura successiva.
 */
export interface SendWindow {
  timezone: string
  startHour: number
  endHour: number
  weekdaysOnly: boolean
}

function localParts(d: Date, tz: string) {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit' })
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]))
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday ?? 'Mon')
  return { day, hour: Number(p.hour) % 24, minute: Number(p.minute) }
}

function safeTz(tz: string): string {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz })
    return tz
  } catch {
    return 'Europe/Rome'
  }
}

export function secondsUntilWindow(now: Date, w: SendWindow): number {
  const tz = safeTz(w.timezone)
  const open = (d: Date) => {
    const { day, hour } = localParts(d, tz)
    if (w.weekdaysOnly && (day === 0 || day === 6)) return false
    return hour >= w.startHour && hour < w.endHour
  }
  if (open(now)) return 0
  // Avanza a passi di 15 minuti (max 8 giorni): semplice e corretto anche con l'ora legale.
  const step = 15 * 60_000
  let t = new Date(Math.ceil(now.getTime() / step) * step)
  for (let i = 0; i < 8 * 96; i++) {
    if (open(t)) return Math.max(60, Math.round((t.getTime() - now.getTime()) / 1000))
    t = new Date(t.getTime() + step)
  }
  return 3600
}
