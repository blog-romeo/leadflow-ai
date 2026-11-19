/** Parser CSV (RFC 4180) con rilevamento del separatore e mappatura automatica delle colonne. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '')
  const firstLine = src.split(/\r?\n/, 1)[0] ?? ''
  const delimiter = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ','
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"'
        i++
      } else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"') quoted = true
    else if (ch === delimiter) {
      row.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++
      row.push(cell)
      cell = ''
      if (row.some((c) => c.trim() !== '')) rows.push(row)
      row = []
    } else cell += ch
  }
  row.push(cell)
  if (row.some((c) => c.trim() !== '')) rows.push(row)
  return rows
}

const ALIASES: Record<string, string[]> = {
  company_name: ['company_name', 'company', 'azienda', 'nome', 'nome azienda', 'ragione sociale', 'denominazione', 'name'],
  website: ['website', 'sito', 'sito web', 'url', 'web'],
  phone: ['phone', 'telefono', 'tel', 'numero di telefono'],
  sector: ['sector', 'settore', 'categoria', 'industry', 'attivita'],
  address: ['address', 'indirizzo', 'via'],
  city: ['city', 'citta', 'comune', 'localita'],
  region: ['region', 'provincia', 'regione', 'state'],
  postal_code: ['postal_code', 'cap', 'postcode', 'zip'],
  country: ['country', 'paese', 'nazione'],
  external_id: ['external_id', 'id', 'codice'],
}

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

export function mapColumns(header: string[]): Record<string, number> {
  const map: Record<string, number> = {}
  header.forEach((h, i) => {
    const f = fold(h)
    for (const [field, names] of Object.entries(ALIASES)) {
      if (!(field in map) && names.includes(f)) map[field] = i
    }
  })
  return map
}

/** Righe pronte per l'API: solo le colonne riconosciute, nessun campo personale aggiuntivo. */
export function toRows(table: string[][]): { rows: Record<string, string>[]; columns: Record<string, number> } {
  const [header = [], ...body] = table
  const columns = mapColumns(header)
  const rows = body.map((r) => {
    const o: Record<string, string> = {}
    for (const [field, idx] of Object.entries(columns)) {
      const v = (r[idx] ?? '').trim()
      if (v) o[field] = v
    }
    return o
  })
  return { rows, columns }
}
