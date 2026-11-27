import { fireEvent, render, screen } from '@testing-library/react'
import { I18nProvider } from '../../i18n'
import { LeadCard, highlight } from './LeadCard'
import { ModeBanner } from './ModeBanner'
import type { LeadView } from './types'

/** Interfaccia Demand Hunter: prove testuali, fonte, feedback e dati simulati sempre dichiarati. Solo dati simulati. */
const lead: LeadView = {
  id: '00000000-0000-4000-8000-000000000001',
  url: 'https://www.facebook.com/groups/esempio-simulato/posts/1-laravel',
  text: 'Stiamo cercando uno sviluppatore Laravel, budget 4000 euro',
  score: 96,
  stage: 'high_intent',
  lead_class: 'cliente',
  technology: ['Laravel'],
  query: 'site:facebook.com/groups "stiamo cercando" "Laravel"',
  verb: 'stiamo cercando',
  object: 'Laravel',
  status: 'new',
  crm_lead_id: null,
  simulated: false,
  verdict: null,
  reading: { author_role: 'buyer', intent_types: ['service_demand'], stage: 'high_intent', confidence: 0.95, urgency: 'high', budget_declared: true, evidence: [{ signal: 'ask', match: 'Stiamo cercando' }, { signal: 'budget', match: 'budget' }] },
  priority: 'high',
  qualified: true,
  reasons: ['budget_declared'],
}
const renderCard = (l: LeadView, onVerdict = vi.fn(), onToggle = vi.fn()) =>
  render(
    <I18nProvider>
      <LeadCard lead={l} selected={false} busy={false} onToggle={onToggle} onVerdict={onVerdict} />
    </I18nProvider>,
  )

describe('Demand Hunter: scheda del lead', () => {
  it('evidenzia nel testo le parole che hanno deciso la classificazione', () => {
    expect(highlight('Stiamo cercando X, budget 10', ['Stiamo cercando', 'budget']).filter((p) => p.hit).map((p) => p.text)).toEqual(['Stiamo cercando', 'budget'])
    expect(highlight('niente', [])).toEqual([{ text: 'niente', hit: false }])
    expect(highlight('a (b) c', ['(b)']).some((p) => p.hit)).toBe(true)
  })
  it('mostra punteggio, prove, fonte esterna sicura e pulsanti Giusto/Sbagliato', () => {
    const onVerdict = vi.fn()
    renderCard(lead, onVerdict)
    expect(screen.getByText('96')).toBeInTheDocument()
    expect(screen.getAllByText('Stiamo cercando').length).toBeGreaterThan(0)
    const link = screen.getByRole('link', { name: /Apri la fonte/ })
    expect(link).toHaveAttribute('href', lead.url)
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'))
    fireEvent.click(screen.getByRole('button', { name: /Giusto/ }))
    expect(onVerdict).toHaveBeenCalledWith('giusto')
    fireEvent.click(screen.getByRole('button', { name: /Sbagliato/ }))
    expect(onVerdict).toHaveBeenCalledWith('sbagliato')
  })
  it('un secondo clic sullo stesso giudizio lo rimuove', () => {
    const onVerdict = vi.fn()
    renderCard({ ...lead, verdict: 'giusto' }, onVerdict)
    fireEvent.click(screen.getByRole('button', { name: /Giusto/ }))
    expect(onVerdict).toHaveBeenCalledWith(null)
  })
  it('i lead simulati sono marcati e non selezionabili per il CRM', () => {
    renderCard({ ...lead, simulated: true })
    expect(screen.getByText('Simulato')).toBeInTheDocument()
    expect(screen.getByRole('checkbox')).toBeDisabled()
  })
  it('lead giudicati sbagliati o già nel CRM non sono selezionabili', () => {
    const { unmount } = renderCard({ ...lead, verdict: 'sbagliato', qualified: false, reasons: ['marked_wrong'] })
    expect(screen.getByRole('checkbox')).toBeDisabled()
    expect(screen.getByText('Non qualificato')).toBeInTheDocument()
    unmount()
    renderCard({ ...lead, status: 'transferred', crm_lead_id: 'x' })
    expect(screen.getByText('Nel CRM')).toBeInTheDocument()
    expect(screen.getByRole('checkbox')).toBeDisabled()
  })
  it('la modalità simulata è sempre dichiarata', () => {
    render(
      <I18nProvider>
        <ModeBanner mode="simulated" />
      </I18nProvider>,
    )
    expect(screen.getByText('Dati simulati')).toBeInTheDocument()
  })
})
