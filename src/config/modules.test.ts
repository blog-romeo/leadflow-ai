import { MODULES, visibleModules } from './modules'
import { it as dict } from '../i18n/it'
import { lookup } from '../i18n'

describe('registro moduli', () => {
  it('contiene i 12 moduli del prodotto con path unici', () => {
    expect(MODULES).toHaveLength(12)
    expect(new Set(MODULES.map((m) => m.path)).size).toBe(12)
  })
  it('ogni modulo in preparazione ha testi descrittivi', () => {
    for (const m of MODULES.filter((m) => m.status === 'preparation')) {
      expect(m.previewKey, m.key).toBeTruthy()
      expect(typeof lookup(dict, `modules.${m.previewKey}.title`)).toBe('string')
    }
  })
  it('i moduli AI sono dichiarati in preparazione (nessuna funzione simulata)', () => {
    expect(MODULES.filter((m) => m.group === 'ai').every((m) => m.status === 'preparation')).toBe(true)
  })
  it('Super Admin visibile solo ai super_admin', () => {
    expect(visibleModules(false).some((m) => m.key === 'admin')).toBe(false)
    expect(visibleModules(true).some((m) => m.key === 'admin')).toBe(true)
  })
})
