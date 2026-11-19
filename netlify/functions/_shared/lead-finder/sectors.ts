import { fold } from './normalize'

/**
 * Catalogo settori: sinonimi IT/EN e corrispondenti tag OpenStreetMap.
 * Usato dall'adapter OSM per costruire la query e dallo scoring per confrontare i settori.
 */
export interface SectorDef {
  key: string
  synonyms: string[]
  /** Filtri Overpass QL (senza parentesi tonde), es. ["tourism"="hotel"]. */
  osm: string[]
}

export const SECTORS: SectorDef[] = [
  { key: 'hotel', synonyms: ['hotel', 'albergo', 'alberghi', 'hotels', 'resort'], osm: ['["tourism"="hotel"]'] },
  { key: 'guest_house', synonyms: ['b&b', 'bed and breakfast', 'b b', 'affittacamere', 'guest house', 'pensione'], osm: ['["tourism"="guest_house"]'] },
  { key: 'restaurant', synonyms: ['ristorante', 'ristoranti', 'restaurant', 'trattoria', 'osteria', 'pizzeria'], osm: ['["amenity"="restaurant"]'] },
  { key: 'cafe_bar', synonyms: ['bar', 'caffe', 'caffetteria', 'cafe', 'pub'], osm: ['["amenity"="cafe"]', '["amenity"="bar"]', '["amenity"="pub"]'] },
  { key: 'dentist', synonyms: ['dentista', 'dentisti', 'studio dentistico', 'odontoiatra', 'dentist'], osm: ['["amenity"="dentist"]', '["healthcare"="dentist"]'] },
  { key: 'doctor', synonyms: ['medico', 'studio medico', 'poliambulatorio', 'clinica', 'doctor', 'clinic'], osm: ['["amenity"="doctors"]', '["amenity"="clinic"]'] },
  { key: 'pharmacy', synonyms: ['farmacia', 'farmacie', 'pharmacy'], osm: ['["amenity"="pharmacy"]'] },
  { key: 'veterinary', synonyms: ['veterinario', 'clinica veterinaria', 'veterinary'], osm: ['["amenity"="veterinary"]'] },
  { key: 'fitness', synonyms: ['palestra', 'palestre', 'fitness', 'gym', 'centro fitness'], osm: ['["leisure"="fitness_centre"]'] },
  { key: 'lawyer', synonyms: ['avvocato', 'avvocati', 'studio legale', 'lawyer', 'law firm'], osm: ['["office"="lawyer"]'] },
  { key: 'accountant', synonyms: ['commercialista', 'commercialisti', 'studio commercialista', 'accountant', 'contabilita'], osm: ['["office"="accountant"]', '["office"="tax_advisor"]'] },
  { key: 'estate_agent', synonyms: ['agenzia immobiliare', 'immobiliare', 'real estate', 'estate agent'], osm: ['["office"="estate_agent"]'] },
  { key: 'architect', synonyms: ['architetto', 'studio di architettura', 'architect'], osm: ['["office"="architect"]'] },
  { key: 'insurance', synonyms: ['assicurazione', 'assicurazioni', 'agenzia assicurativa', 'insurance'], osm: ['["office"="insurance"]'] },
  { key: 'it_company', synonyms: ['software house', 'informatica', 'it', 'software', 'web agency', 'agenzia web'], osm: ['["office"="it"]', '["office"="company"]["company"="software"]'] },
  { key: 'hairdresser', synonyms: ['parrucchiere', 'parrucchieri', 'barbiere', 'hairdresser', 'salone'], osm: ['["shop"="hairdresser"]'] },
  { key: 'beauty', synonyms: ['estetista', 'centro estetico', 'beauty', 'spa'], osm: ['["shop"="beauty"]'] },
  { key: 'car_repair', synonyms: ['officina', 'autofficina', 'meccanico', 'car repair', 'carrozzeria'], osm: ['["shop"="car_repair"]'] },
  { key: 'car_dealer', synonyms: ['concessionaria', 'autosalone', 'car dealer'], osm: ['["shop"="car"]'] },
  { key: 'clothes', synonyms: ['abbigliamento', 'negozio di abbigliamento', 'boutique', 'clothes', 'fashion'], osm: ['["shop"="clothes"]'] },
  { key: 'supermarket', synonyms: ['supermercato', 'alimentari', 'supermarket', 'grocery'], osm: ['["shop"="supermarket"]', '["shop"="convenience"]'] },
  { key: 'bakery', synonyms: ['panificio', 'forno', 'pasticceria', 'bakery'], osm: ['["shop"="bakery"]', '["shop"="pastry"]'] },
  { key: 'optician', synonyms: ['ottico', 'ottica', 'optician'], osm: ['["shop"="optician"]'] },
  { key: 'florist', synonyms: ['fiorista', 'fioraio', 'florist'], osm: ['["shop"="florist"]'] },
  { key: 'travel_agency', synonyms: ['agenzia viaggi', 'agenzie viaggi', 'travel agency', 'tour operator'], osm: ['["shop"="travel_agency"]', '["office"="travel_agent"]'] },
  { key: 'furniture', synonyms: ['mobilificio', 'arredamento', 'mobili', 'furniture'], osm: ['["shop"="furniture"]'] },
  { key: 'hardware', synonyms: ['ferramenta', 'hardware store', 'bricolage'], osm: ['["shop"="hardware"]', '["shop"="doityourself"]'] },
  { key: 'builder', synonyms: ['impresa edile', 'edilizia', 'costruzioni', 'builder', 'construction'], osm: ['["craft"="builder"]', '["office"="construction_company"]'] },
  { key: 'electrician', synonyms: ['elettricista', 'impianti elettrici', 'electrician'], osm: ['["craft"="electrician"]'] },
  { key: 'plumber', synonyms: ['idraulico', 'termoidraulica', 'plumber'], osm: ['["craft"="plumber"]'] },
  { key: 'winery', synonyms: ['cantina', 'azienda vinicola', 'enoteca', 'winery', 'wine'], osm: ['["craft"="winery"]', '["shop"="wine"]'] },
  { key: 'school', synonyms: ['scuola di lingue', 'scuola guida', 'centro formazione', 'language school', 'driving school'], osm: ['["amenity"="language_school"]', '["amenity"="driving_school"]'] },
]

const index = new Map<string, SectorDef>()
for (const s of SECTORS) for (const syn of s.synonyms) index.set(fold(syn), s)

/** Riconosce un settore a partire dal testo inserito dall'utente. */
export function matchSector(input: string | null | undefined): SectorDef | null {
  if (!input) return null
  const f = fold(input)
  if (index.has(f)) return index.get(f) ?? null
  for (const [syn, def] of index) {
    if (syn.length > 2 && (f === syn || f.split(' ').includes(syn) || (syn.includes(' ') && f.includes(syn)))) return def
  }
  return null
}

/** Settore OSM a partire dai tag dell'elemento. */
export function sectorFromOsmTags(tags: Record<string, string>): SectorDef | null {
  for (const s of SECTORS) {
    for (const filter of s.osm) {
      const pairs = [...filter.matchAll(/\["([^"]+)"="([^"]+)"\]/g)]
      if (pairs.length > 0 && pairs.every(([, k, v]) => k && tags[k] === v)) return s
    }
  }
  return null
}
