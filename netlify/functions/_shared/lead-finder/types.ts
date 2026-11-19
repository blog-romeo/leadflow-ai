export type ProviderId = 'osm_overpass' | 'google_places' | 'csv_import'
export type WebsiteFilter = 'any' | 'with' | 'without'
export type Priority = 'high' | 'medium' | 'low'

export interface SearchQuery {
  sector: string
  location: string
  country: string
  keywords: string[]
  maxResults: number
  websiteFilter: WebsiteFilter
}

/** Diritti d'uso dichiarati dalla licenza del provider (verificati sui termini, vedi README). */
export interface ProviderLicense {
  canStoreContent: boolean
  canExport: boolean
  canSaveToCrm: boolean
  attribution: string
  termsUrl: string
}

export interface ProviderCapabilities {
  websiteFilterWith: boolean
  websiteFilterWithout: boolean
  keywordFiltering: boolean
  maxResults: number
}

/** Azienda normalizzata, indipendente dal provider. Mai email o nominativi di persone. */
export interface NormalizedCompany {
  provider: ProviderId
  externalId: string
  companyName: string
  sector: string | null
  categoryTags: string[]
  address: string | null
  city: string | null
  region: string | null
  postalCode: string | null
  country: string | null
  website: string | null
  phone: string | null
  sourceUrl: string | null
  acquiredAt: string
}

export interface ProviderAdapter {
  id: ProviderId
  label: string
  license: ProviderLicense
  capabilities: ProviderCapabilities
  /** Nomi delle variabili d'ambiente mancanti; vuoto se configurato. */
  missingConfig(): string[]
  search(query: SearchQuery, opts: { timeoutMs: number }): Promise<NormalizedCompany[]>
}

export type ProviderErrorCode =
  | 'provider_not_configured'
  | 'provider_timeout'
  | 'provider_rate_limited'
  | 'provider_auth_failed'
  | 'provider_bad_request'
  | 'provider_bad_response'
  | 'provider_unavailable'
  | 'location_not_found'

export class ProviderError extends Error {
  constructor(
    public code: ProviderErrorCode,
    public retryable = false,
  ) {
    super(code)
  }
}

export interface IcpProfile {
  servicesDescription: string | null
  idealCustomer: string | null
  targetSectors: string[]
  targetRegions: string[]
  targetCountries: string[]
  weights: { sector: number; geography: number; icp: number; signals: number; completeness: number }
}

export const DEFAULT_WEIGHTS: IcpProfile['weights'] = { sector: 30, geography: 20, icp: 25, signals: 15, completeness: 10 }
