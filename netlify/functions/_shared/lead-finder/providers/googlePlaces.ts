import { fetchWithTimeout, TimeoutError } from '../../fetchTimeout'
import { cleanText, normalizePhone, normalizeWebsite } from '../normalize'
import { matchSector } from '../sectors'
import { ProviderError, type NormalizedCompany, type ProviderAdapter } from '../types'

/**
 * Google Places API (New) — Text Search.
 *
 * Termini (verificati il 19/11/2026, vedi README):
 * • si può memorizzare solo il place_id (lat/lng al massimo 30 giorni);
 * • per i clienti con fatturazione nello SEE gli usi consentiti sono un elenco chiuso
 *   e non includono in modo esplicito la costruzione di liste lead;
 * • nessun uso dei contenuti insieme a mappe non Google; attribuzione obbligatoria.
 *
 * Di conseguenza: risultati mostrati solo in sessione, nessun contenuto memorizzato
 * (vincolo anche nel database), nessuna esportazione, nessun salvataggio nel CRM.
 * Costo: i campi websiteUri/nationalPhoneNumber attivano lo SKU "Text Search Enterprise".
 */
const ENDPOINT = 'https://places.googleapis.com/v1/places:searchText'
const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.addressComponents',
  'places.primaryType',
  'places.primaryTypeDisplayName',
  'places.types',
  'places.websiteUri',
  'places.nationalPhoneNumber',
  'places.googleMapsUri',
  'nextPageToken',
].join(',')

interface GooglePlace {
  id: string
  displayName?: { text?: string }
  formattedAddress?: string
  addressComponents?: { longText?: string; shortText?: string; types?: string[] }[]
  primaryType?: string
  primaryTypeDisplayName?: { text?: string }
  types?: string[]
  websiteUri?: string
  nationalPhoneNumber?: string
  googleMapsUri?: string
}

function component(p: GooglePlace, type: string, short = false): string | null {
  const c = p.addressComponents?.find((a) => a.types?.includes(type))
  return cleanText(short ? c?.shortText : c?.longText, 120)
}

export function mapGooglePlace(p: GooglePlace, sectorQuery: string, acquiredAt: string): NormalizedCompany | null {
  const name = cleanText(p.displayName?.text, 300)
  if (!p.id || !name) return null
  return {
    provider: 'google_places',
    externalId: p.id,
    companyName: name,
    sector: cleanText(p.primaryTypeDisplayName?.text, 80) ?? matchSector(sectorQuery)?.key ?? null,
    categoryTags: (p.types ?? []).slice(0, 8),
    address: cleanText(p.formattedAddress, 300),
    city: component(p, 'locality') ?? component(p, 'postal_town'),
    region: component(p, 'administrative_area_level_2') ?? component(p, 'administrative_area_level_1'),
    postalCode: component(p, 'postal_code'),
    country: component(p, 'country', true)?.toUpperCase() ?? null,
    website: normalizeWebsite(p.websiteUri),
    phone: normalizePhone(p.nationalPhoneNumber),
    sourceUrl: p.googleMapsUri && /^https:\/\//.test(p.googleMapsUri) ? p.googleMapsUri : null,
    acquiredAt,
  }
}

export function createGooglePlacesAdapter(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): ProviderAdapter {
  const key = env.GOOGLE_PLACES_API_KEY?.trim() ?? ''
  return {
    id: 'google_places',
    label: 'Google Places',
    license: {
      canStoreContent: false,
      canExport: false,
      canSaveToCrm: false,
      attribution: 'Google Maps',
      termsUrl: 'https://cloud.google.com/terms/maps-platform/eea/maps-service-terms',
    },
    // Il filtro sul sito è applicato ai risultati restituiti (Google non lo supporta nella query).
    capabilities: { websiteFilterWith: true, websiteFilterWithout: true, keywordFiltering: true, maxResults: 60 },
    missingConfig() {
      return key ? [] : ['GOOGLE_PLACES_API_KEY']
    },
    async search(q, { timeoutMs }) {
      if (!key) throw new ProviderError('provider_not_configured')
      const deadline = Date.now() + timeoutMs
      const textQuery = [q.sector, ...q.keywords, q.location].map((s) => s.trim()).filter(Boolean).join(' ')
      const acquiredAt = new Date().toISOString()
      const out: NormalizedCompany[] = []
      let pageToken: string | undefined
      for (let page = 0; page < 3 && out.length < q.maxResults; page++) {
        const remainingMs = deadline - Date.now()
        if (remainingMs < 500) break
        let res: Response
        try {
          res = await fetchWithTimeout(
            ENDPOINT,
            {
              method: 'POST',
              headers: { 'content-type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': FIELD_MASK },
              body: JSON.stringify({ textQuery, regionCode: q.country.toUpperCase(), languageCode: 'it', pageSize: 20, ...(pageToken ? { pageToken } : {}) }),
            },
            remainingMs,
            fetchImpl,
          )
        } catch (err) {
          if (err instanceof TimeoutError) {
            if (out.length) break
            throw new ProviderError('provider_timeout', true)
          }
          throw new ProviderError('provider_unavailable', true)
        }
        if (res.status === 429) throw new ProviderError('provider_rate_limited', true)
        if (res.status === 401 || res.status === 403) throw new ProviderError('provider_auth_failed')
        if (res.status === 400) throw new ProviderError('provider_bad_request')
        if (!res.ok) throw new ProviderError('provider_unavailable', true)
        let body: { places?: GooglePlace[]; nextPageToken?: string }
        try {
          body = (await res.json()) as typeof body
        } catch {
          throw new ProviderError('provider_bad_response')
        }
        for (const p of body.places ?? []) {
          const c = mapGooglePlace(p, q.sector, acquiredAt)
          if (!c) continue
          if (q.websiteFilter === 'with' && !c.website) continue
          if (q.websiteFilter === 'without' && c.website) continue
          out.push(c)
        }
        pageToken = body.nextPageToken
        if (!pageToken) break
      }
      return out.slice(0, q.maxResults)
    },
  }
}
