/**
 * Tema White Label: variabili CSS generate SOLO da colori esadecimali validati.
 * Nessun testo fornito dal rivenditore finisce nel foglio di stile (niente CSS injection).
 */
const HEX = /^#[0-9a-f]{6}$/i

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
const toHex = (c: [number, number, number]) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`
const mix = (a: string, b: string, t: number) => {
  const x = rgb(a)
  const y = rgb(b)
  return toHex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t])
}
function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
/** Testo leggibile (bianco o quasi nero) sul colore primario. */
export function inkFor(hex: string): string {
  const l = luminance(hex)
  return (1.05 / (l + 0.05)) >= ((l + 0.05) / 0.05) ? '#ffffff' : '#0b1215'
}

/** CSS generato SOLO da colori esadecimali validati (nessun testo del rivenditore nel foglio di stile). */
export function themeCss(primary: string | null, secondary: string | null): string {
  const p = primary && HEX.test(primary) ? primary : null
  const s = secondary && HEX.test(secondary) ? secondary : null
  if (!p && !s) return ''
  const light: string[] = []
  const dark: string[] = []
  if (p) {
    light.push(`--lf-flow:${p}`, `--lf-flow-ink:${inkFor(p)}`, `--lf-flow-soft:${mix(p, '#ffffff', 0.86)}`)
    const pd = mix(p, '#ffffff', 0.25)
    dark.push(`--lf-flow:${pd}`, `--lf-flow-ink:${inkFor(pd)}`, `--lf-flow-soft:${mix(p, '#0b1215', 0.75)}`)
  }
  if (s) {
    light.push(`--lf-signal:${s}`, `--lf-signal-soft:${mix(s, '#ffffff', 0.86)}`)
    dark.push(`--lf-signal:${mix(s, '#ffffff', 0.2)}`, `--lf-signal-soft:${mix(s, '#0b1215', 0.75)}`)
  }
  return `:root{${light.join(';')}}.dark{${dark.join(';')}}`
}
