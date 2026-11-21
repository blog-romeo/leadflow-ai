import { inkFor, themeCss } from './theme'

describe('tema White Label', () => {
  it('colori validi: variabili per tema chiaro e scuro', () => {
    const css = themeCss('#1d4ed8', '#f59e0b')
    expect(css.startsWith(':root{--lf-flow:#1d4ed8;')).toBe(true)
    expect(css).toContain('.dark{--lf-flow:')
    expect(css).toContain('--lf-signal:#f59e0b')
  })
  it('valori non esadecimali ignorati (nessuna CSS injection)', () => {
    expect(themeCss('red;}body{display:none', 'url(javascript:x)')).toBe('')
    expect(themeCss('#12345', null)).toBe('')
  })
  it('testo leggibile sul colore primario', () => {
    expect(inkFor('#ffffff')).toBe('#0b1215')
    expect(inkFor('#000000')).toBe('#ffffff')
    expect(inkFor('#1d4ed8')).toBe('#ffffff')
    expect(inkFor('#fde047')).toBe('#0b1215')
  })
})
