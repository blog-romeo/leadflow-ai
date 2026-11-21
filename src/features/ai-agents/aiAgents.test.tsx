import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { I18nProvider, lookup } from '../../i18n'
import { it as itDict } from '../../i18n/it'
import { en } from '../../i18n/en'
import { navItems } from '../../config/modules'
import { AI_AGENT_KEYS, type AiAgentApprovalRow } from '../../lib/database.types'

const control = vi.fn()
vi.mock('../../lib/api', async (orig) => ({ ...(await orig<typeof import('../../lib/api')>()), apiFetch: (...a: unknown[]) => control(...a) }))
const { ApprovalCard } = await import('./ApprovalCard')

const approval: AiAgentApprovalRow = {
  id: 'ap-1',
  organization_id: 'org-1',
  workflow_id: 'wf-1',
  step_id: 'st-1',
  action: 'crm.save_leads',
  summary: { candidates: [{ candidate_id: 'c1', company_name: 'Hotel Aurora', score: 85, priority: 'high', in_crm: false }], count: 1, new_leads: 1, estimated_strategy_credits: 2 },
  status: 'pending',
  requested_at: '2026-11-20T10:00:00Z',
  expires_at: '2026-11-23T10:00:00Z',
  decided_by: null,
  decided_at: null,
  decision_note: null,
}

describe('Prompt 8 — interfaccia del motore multi-agent', () => {
  it('menu: AI Agents e AI Workflows visibili solo con il feature flag', () => {
    expect(navItems(false, false).some((m) => m.key === 'aiAgents' || m.key === 'aiWorkflows')).toBe(false)
    const on = navItems(false, true)
    expect(on.map((m) => m.path)).toEqual(expect.arrayContaining(['/app/ai-agents', '/app/ai-workflows']))
    expect(new Set(on.map((m) => m.path)).size).toBe(on.length)
  })

  it('testi presenti in italiano e inglese per agenti, stati, azioni e codici del motore', () => {
    const keys = [
      ...AI_AGENT_KEYS.flatMap((k) => [`aiAgents.agents.${k}.name`, `aiAgents.agents.${k}.description`]),
      ...['pending', 'running', 'waiting_approval', 'completed', 'partial', 'failed', 'cancelled'].map((s) => `aiWorkflows.status.${s}`),
      ...['pending', 'running', 'waiting_approval', 'completed', 'skipped', 'failed', 'cancelled'].map((s) => `aiWorkflows.stepStatus.${s}`),
      ...['discover', 'research', 'score', 'crm_save_leads', 'strategy', 'follow_up_analyze', 'follow_up_apply', 'growth_analyze'].map((a) => `aiWorkflows.actions.${a}`),
      ...['sector_higher_appointment_rate', 'low_contactable_share', 'response_rate', 'lead_volume_increase', 'lead_volume_decrease'].map((c) => `aiWorkflows.insights.${c}`),
      ...['workflow_budget_exceeded', 'org_agent_budget_exceeded', 'cancelled_by_user', 'approval_rejected', 'approval_invalid', 'step_timeout', 'workflow_timeout', 'feature_disabled', 'plan_blocked'].map((c) => `aiWorkflows.codes.${c}`),
      'nav.aiAgents',
      'nav.aiWorkflows',
    ]
    for (const k of keys) {
      expect(typeof lookup(itDict, k), k).toBe('string')
      expect(typeof lookup(en, k), k).toBe('string')
    }
  })

  it('il punteggio è presentato come indice di compatibilità, non come probabilità', () => {
    expect(String(lookup(itDict, 'aiWorkflows.out.measure'))).toContain('non è una probabilità')
    expect(String(lookup(en, 'aiWorkflows.out.measure'))).toContain('not a purchase probability')
  })

  it('approvazione: un membro vede il riepilogo ma non può decidere', () => {
    render(
      <I18nProvider>
        <ApprovalCard approval={approval} orgId="org-1" isAdmin={false} onDone={() => undefined} />
      </I18nProvider>,
    )
    expect(screen.getByText('Hotel Aurora')).toBeInTheDocument()
    expect(screen.getByText(/Nessuna comunicazione verrà inviata/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Approva' })).toBeNull()
    expect(screen.getByText(/Solo un amministratore/)).toBeInTheDocument()
  })

  it('approvazione: un amministratore approva tramite l’API di controllo', async () => {
    control.mockResolvedValue({ decision: 'approve' })
    const onDone = vi.fn()
    render(
      <I18nProvider>
        <ApprovalCard approval={approval} orgId="org-1" isAdmin onDone={onDone} />
      </I18nProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Approva' }))
    await waitFor(() => expect(onDone).toHaveBeenCalled())
    expect(control).toHaveBeenCalledWith('/api/ai-workflows/control', { method: 'POST', body: { organization_id: 'org-1', workflow_id: 'wf-1', action: 'approve', approval_id: 'ap-1' } })
  })
})
