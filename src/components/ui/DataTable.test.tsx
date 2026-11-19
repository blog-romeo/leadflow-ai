import { fireEvent, render, screen } from '@testing-library/react'
import { I18nProvider } from '../../i18n'
import { DataTable } from './DataTable'

const columns = [{ key: 'n', header: 'Nome', render: (r: { id: string; n: string }) => r.n }]

function setup(props: Partial<Parameters<typeof DataTable<{ id: string; n: string }>>[0]> = {}) {
  const onPageChange = vi.fn()
  render(
    <I18nProvider>
      <DataTable
        caption="Test"
        columns={columns}
        rows={[]}
        rowKey={(r) => r.id}
        page={1}
        pageSize={10}
        total={0}
        onPageChange={onPageChange}
        empty={<p>vuoto</p>}
        {...props}
      />
    </I18nProvider>,
  )
  return { onPageChange }
}

describe('DataTable', () => {
  it('mostra lo stato vuoto', () => {
    setup()
    expect(screen.getByText('vuoto')).toBeInTheDocument()
  })
  it('mostra lo stato di errore con riprova', () => {
    const onRetry = vi.fn()
    setup({ error: 'Errore di caricamento', onRetry })
    fireEvent.click(screen.getByRole('button', { name: 'Riprova' }))
    expect(onRetry).toHaveBeenCalled()
  })
  it('pagina in avanti e disabilita indietro alla prima pagina', () => {
    const { onPageChange } = setup({ rows: [{ id: '1', n: 'Alfa' }], total: 25 })
    expect(screen.getByText('Alfa')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Precedente' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Successiva' }))
    expect(onPageChange).toHaveBeenCalledWith(2)
  })
})
