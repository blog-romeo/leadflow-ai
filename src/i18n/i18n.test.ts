import { it as itDict } from './it'
import { en } from './en'
import { interpolate, translate } from './index'

function keys(obj: unknown, prefix = ''): string[] {
  if (Array.isArray(obj) || typeof obj !== 'object' || obj === null) return [prefix]
  return Object.entries(obj).flatMap(([k, v]) => keys(v, prefix ? `${prefix}.${k}` : k))
}

describe('i18n', () => {
  it('italiano e inglese hanno le stesse chiavi', () => {
    expect(keys(en).sort()).toEqual(keys(itDict).sort())
  })
  it('interpolazione', () => {
    expect(interpolate('Pagina {page} di {total}', { page: 1, total: 3 })).toBe('Pagina 1 di 3')
  })
  it('traduce e ripiega sulla chiave se mancante', () => {
    expect(translate('it', 'common.signIn')).toBe('Accedi')
    expect(translate('en', 'common.signIn')).toBe('Sign in')
    expect(translate('it', 'non.esiste')).toBe('non.esiste')
  })
})
