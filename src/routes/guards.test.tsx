import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { AuthContext, type AuthValue } from '../contexts/AuthContext'
import { I18nProvider } from '../i18n'
import { RequireAuth, RequireOrganization, PublicOnly } from './guards'
import type { Session } from '@supabase/supabase-js'

const base: AuthValue = {
  status: 'ready',
  configured: true,
  session: null,
  user: null,
  profile: null,
  memberships: [],
  currentOrg: null,
  currentRole: null,
  isSuperAdmin: false,
  isOrgAdmin: false,
  contextError: null,
  setCurrentOrgId: () => {},
  refresh: async () => {},
  signOut: async () => {},
}
const session = { user: { id: 'u1' } } as unknown as Session
const org = { id: 'o1', name: 'Alfa', slug: 'alfa', vat_number: null, country: 'IT', data_retention_days: 730, created_by: 'u1', created_at: '', updated_at: '', deleted_at: null }

function renderAt(path: string, auth: Partial<AuthValue>) {
  return render(
    <I18nProvider>
      <AuthContext.Provider value={{ ...base, ...auth }}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/login" element={<p>login page</p>} />
            <Route path="/onboarding" element={<p>onboarding page</p>} />
            <Route element={<PublicOnly />}>
              <Route path="/register" element={<p>register page</p>} />
            </Route>
            <Route element={<RequireAuth />}>
              <Route element={<RequireOrganization />}>
                <Route path="/app" element={<p>private app</p>} />
              </Route>
            </Route>
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>
    </I18nProvider>,
  )
}

describe('route guards', () => {
  it('senza sessione la rotta privata reindirizza al login', () => {
    renderAt('/app', {})
    expect(screen.getByText('login page')).toBeInTheDocument()
    expect(screen.queryByText('private app')).not.toBeInTheDocument()
  })
  it('durante il caricamento non mostra contenuti privati', () => {
    renderAt('/app', { status: 'loading', session })
    expect(screen.queryByText('private app')).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toBeInTheDocument()
  })
  it('utente senza organizzazione va all’onboarding', () => {
    renderAt('/app', { session })
    expect(screen.getByText('onboarding page')).toBeInTheDocument()
  })
  it('utente con organizzazione accede all’app', () => {
    renderAt('/app', { session, currentOrg: org, currentRole: 'organization_admin' })
    expect(screen.getByText('private app')).toBeInTheDocument()
  })
  it('utente autenticato non vede le pagine pubbliche di registrazione', () => {
    renderAt('/register', { session, currentOrg: org })
    expect(screen.queryByText('register page')).not.toBeInTheDocument()
  })
})
