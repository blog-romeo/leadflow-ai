import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { I18nProvider } from '../../i18n'

const update = vi.fn()
vi.mock('../../lib/supabase', () => ({
  supabase: { from: () => ({ update: (patch: unknown) => ({ eq: () => update(patch) }) }) },
}))

const { StageSelect } = await import('./StageSelect')

function setup(contactable: boolean) {
  const onChanged = vi.fn()
  const onError = vi.fn()
  render(
    <I18nProvider>
      <StageSelect leadId="l1" name="Hotel Aurora" value="qualified" contactable={contactable} onChanged={onChanged} onError={onError} />
    </I18nProvider>,
  )
  return { onChanged, onError, select: screen.getByLabelText('Sposta Hotel Aurora in') as HTMLSelectElement }
}

describe('4. Pipeline: controllo accessibile equivalente al drag-and-drop', () => {
  beforeEach(() => update.mockReset())

  it('elenca i 12 stati e sposta il lead', async () => {
    update.mockResolvedValue({ error: null })
    const { onChanged, select } = setup(true)
    expect(select.options).toHaveLength(12)
    fireEvent.change(select, { target: { value: 'meeting_scheduled' } })
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith('meeting_scheduled'))
    expect(update).toHaveBeenCalledWith({ status: 'meeting_scheduled' })
  })

  it('per un lead non contattabile restano selezionabili solo chiusura e "Non contattabile" (come nel database)', () => {
    const { select } = setup(false)
    const enabled = [...select.options].filter((o) => !o.disabled).map((o) => o.value)
    expect(enabled).toEqual(['won', 'lost', 'not_contactable'])
  })

  it('mostra l’errore del database (es. lead non contattabile)', async () => {
    update.mockResolvedValue({ error: { code: 'P0001', message: 'lead_not_contactable' } })
    const { onError, onChanged, select } = setup(true)
    fireEvent.change(select, { target: { value: 'contacted' } })
    await waitFor(() => expect(onError).toHaveBeenCalledWith('Il lead non è contattabile: operazione bloccata.'))
    expect(onChanged).not.toHaveBeenCalled()
  })
})
