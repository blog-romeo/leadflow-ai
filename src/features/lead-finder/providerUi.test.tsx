import { render, screen } from '@testing-library/react'
import { I18nProvider } from '../../i18n'
import { AuthContext, type AuthValue } from '../../contexts/AuthContext'
import { ProviderStatus } from './ProviderStatus'
import { SearchForm } from './SearchForm'
import type { ProviderInfo, ProvidersResponse } from './types'

const osm: ProviderInfo = {
  id: 'osm_overpass',
  label: 'OpenStreetMap (Overpass)',
  configured: false,
  missing: ['OVERPASS_API_URL', 'OVERPASS_CONTACT'],
  license: { canStoreContent: true, canExport: true, canSaveToCrm: true, attribution: '© OpenStreetMap contributors', termsUrl: 'https://www.openstreetmap.org/copyright' },
  capabilities: { websiteFilterWith: true, websiteFilterWithout: true, keywordFiltering: false, maxResults: 100 },
}
const google: ProviderInfo = {
  ...osm,
  id: 'google_places',
  label: 'Google Places',
  missing: ['GOOGLE_PLACES_API_KEY'],
  license: { canStoreContent: false, canExport: false, canSaveToCrm: false, attribution: 'Google Maps', termsUrl: 'https://cloud.google.com/terms' },
}

function withAuth(ui: React.ReactNode, admin: boolean) {
  const value = { isOrgAdmin: admin } as AuthValue
  return render(
    <I18nProvider>
      <AuthContext.Provider value={value}>{ui}</AuthContext.Provider>
    </I18nProvider>,
  )
}

describe('2. Provider senza credenziali (interfaccia)', () => {
  it('mostra "Configurazione richiesta" e le variabili mancanti solo agli admin', () => {
    const data: ProvidersResponse = { providers: [osm, google], ai: { configured: false, missing: ['OPENAI_API_KEY'] } }
    withAuth(<ProviderStatus data={data} />, true)
    expect(screen.getAllByText('Configurazione richiesta')).toHaveLength(3)
    expect(screen.getByText(/OVERPASS_API_URL, OVERPASS_CONTACT/)).toBeInTheDocument()
    expect(screen.getByText(/salvataggio nel crm: non consentita/i)).toBeInTheDocument()
  })
  it('i membri vedono un invito a contattare un amministratore', () => {
    withAuth(<ProviderStatus data={{ providers: [{ ...osm, missing: [] }], ai: { configured: true, missing: [] } }} />, false)
    expect(screen.getByText(/Chiedi a un amministratore/)).toBeInTheDocument()
    expect(screen.queryByText(/OVERPASS_API_URL/)).not.toBeInTheDocument()
  })
  it('il pulsante di ricerca è disabilitato se nessuna fonte è configurata', () => {
    withAuth(<SearchForm providers={[osm, google]} busy={false} onSubmit={() => {}} />, true)
    expect(screen.getByRole('button', { name: /Trova nuovi clienti/ })).toBeDisabled()
  })
})
