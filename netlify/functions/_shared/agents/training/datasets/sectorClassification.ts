import type { Dataset } from './types'

export interface SectorCase { id: string; input: string; expected: string | null }
const c = (id: string, input: string, expected: string | null): SectorCase => ({ id, input, expected })

/** Classificazione del settore dal testo libero (null = il catalogo non copre il settore: astensione corretta). */
export const sectorClassificationV1: Dataset<SectorCase> = {
  id: 'sector_classification',
  version: '1.0.0',
  task: 'sector_classification',
  synthetic: true,
  notice: 'Testi sintetici scritti a mano; etichetta = settore del catalogo che una persona assegnerebbe, null se il catalogo non lo prevede.',
  splits: {
    train: [
      c('sc-tr-01', 'Hotel 4 stelle', 'hotel'), c('sc-tr-02', 'albergo a conduzione familiare', 'hotel'), c('sc-tr-03', 'pizzeria napoletana', 'restaurant'),
      c('sc-tr-04', 'studio legale associato', 'lawyer'), c('sc-tr-05', 'farmacia comunale', 'pharmacy'), c('sc-tr-06', 'studio odontoiatrico', 'dentist'),
      c('sc-tr-07', 'bed & breakfast', 'guest_house'), c('sc-tr-08', 'parrucchiera per signora', 'hairdresser'), c('sc-tr-09', 'concessionario auto usate', 'car_dealer'),
      c('sc-tr-10', 'termoidraulico', 'plumber'), c('sc-tr-11', 'agriturismo con piscina', null), c('sc-tr-12', 'notaio', null),
      c('sc-tr-13', 'palestra crossfit', 'fitness'), c('sc-tr-14', 'web agency', 'it_company'), c('sc-tr-15', 'gelateria artigianale', null),
      c('sc-tr-16', 'autoriparazioni', 'car_repair'), c('sc-tr-17', 'ottica e optometria', 'optician'), c('sc-tr-18', 'impresa edile', 'builder'),
      c('sc-tr-19', 'ristorante di pesce', 'restaurant'), c('sc-tr-20', 'consulente del lavoro', null),
    ],
    validation: [
      c('sc-va-01', 'hotel boutique', 'hotel'), c('sc-va-02', 'alberghi del centro storico', 'hotel'), c('sc-va-03', 'trattoria romana', 'restaurant'),
      c('sc-va-04', 'avvocato penalista', 'lawyer'), c('sc-va-05', 'dentista pediatrico', 'dentist'), c('sc-va-06', 'clinica odontoiatrica', 'dentist'),
      c('sc-va-07', 'b&b vista mare', 'guest_house'), c('sc-va-08', 'parrucchiera unisex', 'hairdresser'), c('sc-va-09', 'concessionario moto', 'car_dealer'),
      c('sc-va-10', 'impianti termoidraulici', 'plumber'), c('sc-va-11', 'scuola di danza', null), c('sc-va-12', 'studio notarile', null),
      c('sc-va-13', 'centro fitness', 'fitness'), c('sc-va-14', 'software house', 'it_company'), c('sc-va-15', 'cartoleria', null),
      c('sc-va-16', 'carrozzeria', 'car_repair'), c('sc-va-17', 'panificio', 'bakery'), c('sc-va-18', 'costruzioni generali', 'builder'),
      c('sc-va-19', 'osteria', 'restaurant'), c('sc-va-20', 'tabaccheria', null),
    ],
    test: [
      c('sc-te-01', 'grand hotel', 'hotel'), c('sc-te-02', 'albergo diffuso', 'hotel'), c('sc-te-03', 'ristorante vegano', 'restaurant'),
      c('sc-te-04', 'studio legale tributario', 'lawyer'), c('sc-te-05', 'farmacia notturna', 'pharmacy'), c('sc-te-06', 'ambulatorio odontoiatrico', 'dentist'),
      c('sc-te-07', 'bed and breakfast in campagna', 'guest_house'), c('sc-te-08', 'parrucchiera e barbiere', 'hairdresser'), c('sc-te-09', 'concessionario veicoli commerciali', 'car_dealer'),
      c('sc-te-10', 'ditta termoidraulica', 'plumber'), c('sc-te-11', 'agriturismo biologico', null), c('sc-te-12', 'agenzia di pompe funebri', null),
      c('sc-te-13', 'palestra di arti marziali', 'fitness'), c('sc-te-14', 'agenzia web e grafica', 'it_company'), c('sc-te-15', 'libreria indipendente', null),
      c('sc-te-16', 'officina meccanica', 'car_repair'), c('sc-te-17', 'pasticceria siciliana', 'bakery'), c('sc-te-18', 'edilizia e ristrutturazioni', 'builder'),
      c('sc-te-19', 'enoteca di quartiere', 'winery'), c('sc-te-20', 'lavanderia self service', null),
    ],
  },
}
