import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { I18nProvider } from './i18n'
import { ThemeProvider } from './contexts/ThemeContext'
import { AuthProvider } from './contexts/AuthContext'
import { TenantProvider } from './contexts/TenantContext'
import { installErrorReporting } from './lib/errorReporting'

installErrorReporting()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TenantProvider>
    <ThemeProvider>
      <I18nProvider>
        <AuthProvider>
          <App />
        </AuthProvider>
      </I18nProvider>
    </ThemeProvider>
    </TenantProvider>
  </StrictMode>,
)
