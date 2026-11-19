import { parseCsv, toRows } from './csv'

describe('parser CSV', () => {
  it('gestisce virgolette, separatore ; e intestazioni italiane', () => {
    const table = parseCsv('﻿Ragione sociale;Sito web;Città;Email\n"Rossi; Figli srl";rossi.example;Milano;mario@rossi.example\n\n')
    const { rows, columns } = toRows(table)
    expect(columns).toEqual({ company_name: 0, website: 1, city: 2 })
    expect(rows).toEqual([{ company_name: 'Rossi; Figli srl', website: 'rossi.example', city: 'Milano' }])
    // La colonna email non è mappata: non viene inviata al server.
    expect(JSON.stringify(rows)).not.toContain('mario@')
  })
  it('virgolette doppie escapate e separatore virgola', () => {
    expect(parseCsv('name,phone\n"Bar ""Centrale""",06 123\r\n')).toEqual([['name', 'phone'], ['Bar "Centrale"', '06 123']])
  })
})
