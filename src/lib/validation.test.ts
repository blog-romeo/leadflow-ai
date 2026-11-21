import { validateEmail, validateOrganizationName, validatePassword, validateRetentionDays, validateVatNumber, normalizeVat } from './validation'
import { escapeLike } from './useDebounced'
import { errorKey } from './errors'

describe('validation', () => {
  it('email', () => {
    expect(validateEmail('anna@azienda.test').ok).toBe(true)
    expect(validateEmail('').ok).toBe(false)
    expect(validateEmail('non-una-email').ok).toBe(false)
  })
  it('password richiede lunghezza, lettere e numeri', () => {
    expect(validatePassword('corta1').ok).toBe(false)
    expect(validatePassword('solamentelettere').ok).toBe(false)
    expect(validatePassword('Password2026').ok).toBe(true)
  })
  it('nome organizzazione', () => {
    expect(validateOrganizationName(' A ').ok).toBe(false)
    expect(validateOrganizationName('Alfa Srl').ok).toBe(true)
    expect(validateOrganizationName('x'.repeat(121)).ok).toBe(false)
  })
  it('partita IVA facoltativa e allineata al vincolo SQL', () => {
    expect(validateVatNumber('').ok).toBe(true)
    expect(validateVatNumber('IT 0123 4567 890').ok).toBe(true)
    expect(validateVatNumber('ZZ!!').ok).toBe(false)
    expect(normalizeVat(' it01234567890 ')).toBe('IT01234567890')
    expect(normalizeVat('  ')).toBeNull()
  })
  it('retention nei limiti del database', () => {
    expect(validateRetentionDays(29).ok).toBe(false)
    expect(validateRetentionDays(730).ok).toBe(true)
    expect(validateRetentionDays(3651).ok).toBe(false)
  })
  it('escape dei caratteri jolly ILIKE', () => {
    expect(escapeLike('50%_off\\')).toBe('50\\%\\_off\\\\')
  })
  it('mappa errori senza esporre dettagli', () => {
    expect(errorKey({ message: 'Invalid login credentials' })).toBe('errors.invalidCredentials')
    expect(errorKey({ code: '42501', message: 'new row violates row-level security policy' })).toBe('errors.forbidden')
    expect(errorKey({ message: 'qualcosa di interno' })).toBe('errors.generic')
  })
})
