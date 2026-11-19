import { MODULES, visibleModules } from './modules'
import { it as dict } from '../i18n/it'
import { lookup } from '../i18n'

describe('registro moduli', () => {
  it('contiene i 12 moduli del prodotto con path unici', () => {
    expect(MODULES).toHaveLength(12)
    expect(new Set(MODULES.map((m) => m.path)).size).toBe(12)
  })
  it('ogni modulo con pagina descrittiva ha i testi', () => {
    for (const m of MODULES.filter((m) => m.previewKey)) {
      expect(m.previewKey, m.key).toBeTruthy()
      expect(typeof lookup(dict, `modules.${m.previewKey}.title`)).toBe('string')
    }
  })
  it('stato dei moduli AI coerente con le funzioni realmente operative', () => {
    const status = Object.fromEntries(MODULES.filter((m) => m.group === 'ai').map((m) => [m.key, m.status]))
    expect(status).toEqual({ leadFinder: 'available', analyzer: 'available', scoring: 'available', salesAgent: 'preparation' })
  })
  it('Super Admin visibile solo ai super_admin', () => {
    expect(visibleModules(false).some((m) => m.key === 'admin')).toBe(false)
    expect(visibleModules(true).some((m) => m.key === 'admin')).toBe(true)
  })
})
