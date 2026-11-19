import { fetchWithTimeout, TimeoutError } from '../../fetchTimeout'
import { cleanText, normalizePhone, normalizeWebsite } from '../normalize'
import { matchSector, sectorFromOsmTags } from '../sectors'
import { ProviderError, type NormalizedCompany, type ProviderAdapter, type SearchQuery } from '../types'

/**
 * OpenStreetMap tramite Overpass API.
 *
 * Licenza: ODbL 1.0 — uso commerciale, memorizzazione ed esportazione consentiti con
 * attribuzione "© OpenStreetMap contributors". La condivisione allo stesso modo si applica
 * solo se si distribuisce pubblicamente un database derivato (non è il caso del CRM interno).
 *
 * Endpoint: la policy dell'istanza pubblica overpass-api.de chiede che l'uso commerciale
 * avvenga su server propri o a pagamento e sconsiglia app ospitate su netlify.app.
 * Per questo l'endpoint è OBBLIGATORIO e va configurato (OVERPASS_API_URL).
 */
interface OsmElement {
  type: 'node' | 'way' | 'relation'
  id: number
  tags?: Record<string, string>
}

export function escapeOverpassString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')
}

export function escapeOverpassRegex(value: string): string {
  return escapeOverpassString(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
}

/** Costruisce la query Overpass QL. Esportata per i test. */
export function buildOverpassQuery(q: SearchQuery, serverTimeoutSec: number): string {
  const sector = matchSector(q.sector)
  const location = escapeOverpassRegex(q.location.trim())
  const country = q.country.toUpperCase()
  const filters: string[] = []
  if (q.websiteFilter === 'with') filters.push('[~"^(website|contact:website)$"~"."]')
  if (q.websiteFilter === 'without') filters.push('[!"website"][!"contact:website"]')
  // "indipendenti": esclude le strutture associate a un marchio/catena (tag brand).
  if (q.keywords.some((k) => /indipendent|independent/i.test(k))) filters.push('[!"brand"]')
  const extra = filters.join('')

  const selectors = sector
    ? sector.osm.map((f) => `nwr${f}["name"]${extra}(area.place)(area.country);`)
    : [`nwr["name"~"${escapeOverpassRegex(q.sector.trim())}",i][~"^(shop|office|craft|amenity|tourism|healthcare|leisure)$"~"."]${extra}(area.place)(area.country);`]

  return [
    `[out:json][timeout:${serverTimeoutSec}];`,
    `area["ISO3166-1"="${country}"]["admin_level"="2"]->.country;`,
    `area["boundary"="administrative"][~"^name(:it|:en)?$"~"^${location}$",i](area.country)->.place;`,
    `(`,
    ...selectors.map((s) => `  ${s}`),
    `);`,
    `out center tags ${Math.max(1, Math.min(q.maxResults, 200))};`,
  ].join('\n')
}

export function mapOsmElement(el: OsmElement, q: SearchQuery, acquiredAt: string): NormalizedCompany | null {
  const tags = el.tags ?? {}
  const name = cleanText(tags.name, 300)
  if (!name) return null
  const sectorDef = sectorFromOsmTags(tags) ?? matchSector(q.sector)
  const categoryTags = ['tourism', 'amenity', 'shop', 'office', 'craft', 'healthcare', 'leisure']
    .filter((k) => tags[k])
    .map((k) => `${k}=${tags[k]}`)
  const street = [tags['addr:street'], tags['addr:housenumber']].filter(Boolean).join(' ')
  return {
    provider: 'osm_overpass',
    externalId: `${el.type}/${el.id}`,
    companyName: name,
    sector: sectorDef?.key ?? cleanText(q.sector, 80),
    categoryTags,
    address: cleanText(street, 300),
    city: cleanText(tags['addr:city'], 120) ?? cleanText(q.location, 120),
    region: cleanText(tags['addr:province'] ?? tags['addr:state'], 120),
    postalCode: cleanText(tags['addr:postcode'], 20),
    country: q.country.toUpperCase(),
    website: normalizeWebsite(tags.website ?? tags['contact:website'] ?? tags.url),
    phone: normalizePhone(tags.phone ?? tags['contact:phone']),
    sourceUrl: `https://www.openstreetmap.org/${el.type}/${el.id}`,
    acquiredAt,
  }
}

export function createOsmOverpassAdapter(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): ProviderAdapter {
  const endpoint = env.OVERPASS_API_URL?.trim() ?? ''
  const contact = env.OVERPASS_CONTACT?.trim() ?? ''
  return {
    id: 'osm_overpass',
    label: 'OpenStreetMap (Overpass)',
    license: {
      canStoreContent: true,
      canExport: true,
      canSaveToCrm: true,
      attribution: '© OpenStreetMap contributors, ODbL 1.0',
      termsUrl: 'https://www.openstreetmap.org/copyright',
    },
    capabilities: { websiteFilterWith: true, websiteFilterWithout: true, keywordFiltering: false, maxResults: 100 },
    missingConfig() {
      const missing: string[] = []
      if (!/^https:\/\//.test(endpoint)) missing.push('OVERPASS_API_URL')
      if (!contact) missing.push('OVERPASS_CONTACT')
      return missing
    },
    async search(q, { timeoutMs }) {
      if (this.missingConfig().length) throw new ProviderError('provider_not_configured')
      const query = buildOverpassQuery(q, Math.max(5, Math.floor(timeoutMs / 1000) - 1))
      const headers: Record<string, string> = {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
        'user-agent': `LeadFlowAI/0.2 (+${contact})`,
      }
      if (env.OVERPASS_API_KEY) headers.authorization = `Bearer ${env.OVERPASS_API_KEY}`
      let res: Response
      try {
        res = await fetchWithTimeout(endpoint, { method: 'POST', headers, body: new URLSearchParams({ data: query }) }, timeoutMs, fetchImpl)
      } catch (err) {
        if (err instanceof TimeoutError) throw new ProviderError('provider_timeout', true)
        throw new ProviderError('provider_unavailable', true)
      }
      if (res.status === 429 || res.status === 406) throw new ProviderError('provider_rate_limited', true)
      if (res.status === 401 || res.status === 403) throw new ProviderError('provider_auth_failed')
      if (res.status === 400) throw new ProviderError('provider_bad_request')
      if (res.status === 504) throw new ProviderError('provider_timeout', true)
      if (!res.ok) throw new ProviderError('provider_unavailable', true)
      let body: { elements?: OsmElement[]; remark?: string }
      try {
        body = (await res.json()) as typeof body
      } catch {
        throw new ProviderError('provider_bad_response')
      }
      if (body.remark && /runtime error|timed out|out of memory/i.test(body.remark)) {
        throw new ProviderError(/timed out/i.test(body.remark) ? 'provider_timeout' : 'provider_unavailable', true)
      }
      if (!Array.isArray(body.elements)) throw new ProviderError('provider_bad_response')
      const acquiredAt = new Date().toISOString()
      const mapped = body.elements.map((el) => mapOsmElement(el, q, acquiredAt)).filter((c): c is NormalizedCompany => c !== null)
      // Filtro di sicurezza anche lato applicazione, oltre a quello nella query.
      return mapped
        .filter((c) => (q.websiteFilter === 'with' ? !!c.website : q.websiteFilter === 'without' ? !c.website : true))
        .slice(0, q.maxResults)
    },
  }
}

