import type { ProviderAdapter, ProviderId } from '../types'
import { createOsmOverpassAdapter } from './osmOverpass'
import { createGooglePlacesAdapter } from './googlePlaces'

/**
 * Registro dei provider di ricerca. Per aggiungere un provider B2B con licenza:
 * implementare ProviderAdapter, dichiararne i diritti in `license` dopo aver verificato
 * i termini, e registrarlo qui. Nessun provider restituisce dati senza credenziali reali.
 */
export type SearchProviderId = Exclude<ProviderId, 'csv_import'>

export function createRegistry(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): Record<SearchProviderId, ProviderAdapter> {
  return {
    osm_overpass: createOsmOverpassAdapter(env, fetchImpl),
    google_places: createGooglePlacesAdapter(env, fetchImpl),
  }
}

export const CSV_LICENSE = {
  canStoreContent: true,
  canExport: true,
  canSaveToCrm: true,
  attribution: '',
  termsUrl: '',
} as const
