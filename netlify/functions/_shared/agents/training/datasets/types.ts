/**
 * Dataset versionati del framework di valutazione (Prompt 12).
 * TUTTI SINTETICI: aziende, testi e output inventati dal team (domini .example/.test), nessun dato di clienti.
 * Le etichette sono giudizi scritti a mano, non esiti commerciali verificati. Split separati (train /
 * validation / test) senza sovrapposizioni: verificato da `checkContamination` e dai test.
 */
export type Split = 'train' | 'validation' | 'test'
export interface Dataset<C> {
  id: string
  version: string
  task: string
  synthetic: true
  notice: string
  splits: Record<Split, C[]>
}
