import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { I18nProvider } from '../../i18n'
import { navItems } from '../../config/modules'

/** Pagina Demand Hunter con API simulate: stati onesti (non collegato / simulato), quattro passaggi, risultati. */
const api = vi.fn()
vi.mock('../../lib/api', async (orig) => ({ ...(await orig<typeof import('../../lib/api')>()), apiFetch: (...a: unknown[]) => api(...a) }))
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ currentOrg: { id: '11111111-1111-4111-8111-111111111111' } }) }))
const DemandHunter = (await import('../../pages/app/DemandHunter')).default

const usage = { enabled: true, monthly_paid_calls: 200, max_budget_per_hunt: 50, used: 12, remaining: 188 }
const ready = { configured: true, config_missing: [], service: { reachable: true, mode: 'simulated', search_provider_configured: true, max_budget_per_hunt: 100, running: 0 }, service_error: null, usage, sessions: [] }
const view = {
  service_reachable: true,
  job: { id: 'j1', kind: 'hunt', status: 'completed', mode: 'simulated', reserved_calls: 5, spent: { searches: 4, autocomplete: 1 }, progress: { by_status: { provata: 4 } }, error_code: null, created_at: '2026-11-27T10:00:00Z' },
  session: { id: 's1', goal: 'clienti', seed: 'Laravel', budget: 5, status: 'completed', combos_total: 60, leads_found: 1, events: [{ at: '10:00:01', kind: 'ricerca', text: 'q → 3 risultati, 1 lead' }], verbs: [], objects: [] },
  combos: [{ query: 'q', verb: 'cerco', object: 'Laravel', origin: 'seed', status: 'provata', results: 3, leads: 1, priority: 1 }],
  leads: [{ id: 'l1', url: 'https://www.facebook.com/groups/esempio-simulato/posts/1', text: 'Cerco sviluppatore Laravel, budget 3000', score: 90, stage: 'high_intent', lead_class: 'cliente', technology: ['Laravel'], query: 'q', verb: 'cerco', object: 'Laravel', status: 'new', crm_lead_id: null, simulated: true, verdict: null, reading: { author_role: 'buyer', intent_types: [], stage: 'high_intent', confidence: 0.9, urgency: 'low', budget_declared: true, evidence: [{ signal: 'budget', match: 'budget' }] }, priority: 'high', qualified: true, reasons: [] }],
}
const learning = { source: 'service', totals: { searches: 4 }, verbs: [{ key: 'cerco', searches: 4, posts: 6, leads: 1, confirmed: 0, wrong: 0, rate: 0.25, score: 0.3 }], objects: [], patterns: [] }

const renderAt = (url = '/app/demand-hunter') =>
  render(
    <I18nProvider>
      <MemoryRouter initialEntries={[url]}>
        <DemandHunter />
      </MemoryRouter>
    </I18nProvider>,
  )

describe('Demand Hunter: pagina', () => {
  beforeEach(() => {
    api.mockReset()
  })
  it('voce di menu accanto al Lead Finder', () => {
    const keys = navItems(false, false).map((m) => m.key)
    expect(keys.indexOf('demandHunter')).toBe(keys.indexOf('leadFinder') + 1)
  })
  it('servizio non collegato: lo dice e non mostra passaggi né dati', async () => {
    api.mockResolvedValue({ ...ready, configured: false, service: { reachable: false }, service_error: 'demand_hunter_not_configured' })
    renderAt()
    expect(await screen.findByText('Servizio Demand Hunter non collegato')).toBeInTheDocument()
    expect(screen.queryByText('Che cosa vuoi trovare?')).not.toBeInTheDocument()
  })
  it('modalità simulata dichiarata; passaggio 1 → 2 con l\'albero delle aree', async () => {
    api.mockImplementation(async (path: string) => {
      if (path.startsWith('/api/demand-hunter/status')) return ready
      if (path.startsWith('/api/demand-hunter/areas')) return { mode: 'simulated', suggestions: [{ seed: 'gestionale', reason: 'tra le richieste IT più comuni', source: 'lista' }], tree: { label: 'Clienti', rel: 'obiettivo', source: 'elenco', hunted: 0, leads: 0, children: [{ label: 'Cybersecurity', rel: 'area', source: 'elenco', hunted: 2, leads: 1, children: [] }] } }
      throw new Error(path)
    })
    renderAt()
    expect(await screen.findByText('Dati simulati')).toBeInTheDocument()
    expect(screen.getByText('12 di 200 chiamate a pagamento usate')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Esplora il mercato/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Cybersecurity' }))
    expect(screen.getByLabelText('Argomento da cercare')).toHaveValue('Cybersecurity')
    expect(screen.getByText('gestionale')).toBeInTheDocument()
  })
  it('stima: senza la casella di conferma il pulsante di avvio resta disattivato', async () => {
    api.mockImplementation(async (path: string) => {
      if (path.startsWith('/api/demand-hunter/status')) return ready
      if (path.startsWith('/api/demand-hunter/areas')) return { mode: 'simulated', suggestions: [], tree: { label: 'Clienti', rel: '', source: '', hunted: 0, leads: 0, children: [] } }
      if (path === '/api/demand-hunter/estimate') return { action: 'hunt', goal: 'clienti', subject: 'Laravel', paid_calls: 10, mode: 'simulated', usage, plan: { combos: 60, verbs: ['cerco'], objects: ['Laravel'] }, allowed: true, confirm_token: 'a'.repeat(43), expires_at: '2026-11-27T10:10:00Z' }
      throw new Error(path)
    })
    renderAt()
    fireEvent.click(await screen.findByRole('button', { name: /Esplora il mercato/ }))
    fireEvent.change(screen.getByLabelText('Argomento da cercare'), { target: { value: 'Laravel' } })
    fireEvent.click(screen.getByRole('button', { name: /Prepara la ricerca/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Calcola la stima' }))
    const startBtn = await screen.findByRole('button', { name: 'Avvia la ricerca' })
    expect(startBtn).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox'))
    expect(startBtn).toBeEnabled()
    expect(api).not.toHaveBeenCalledWith('/api/demand-hunter/start', expect.anything())
  })
  it('risultati: lead con prove, badge simulato, apprendimento', async () => {
    api.mockImplementation(async (path: string) => {
      if (path.startsWith('/api/demand-hunter/status')) return ready
      if (path.startsWith('/api/demand-hunter/job')) return view
      if (path.startsWith('/api/demand-hunter/learning')) return learning
      throw new Error(path)
    })
    renderAt('/app/demand-hunter?job=00000000-0000-4000-8000-000000000001')
    expect(await screen.findByText(/Cerco sviluppatore Laravel/)).toBeInTheDocument()
    expect(screen.getAllByText('Simulato').length).toBeGreaterThan(0)
    await waitFor(() => expect(screen.getByText('1 lead su 4 ricerche')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /Trasferisci nel CRM/ })).toBeDisabled()
  })
})
