import type { Dataset } from './types'

/** Gestione errori del provider aziende: risposta HTTP simulata → codice ed eventuale retry attesi. */
export interface ProviderErrorCase { id: string; status: number; body: string; expectedCode: string; retryable: boolean }
const e = (id: string, status: number, body: string, expectedCode: string, retryable: boolean): ProviderErrorCase => ({ id, status, body, expectedCode, retryable })

export const providerErrorsV1: Dataset<ProviderErrorCase> = {
  id: 'provider_errors',
  version: '1.0.0',
  task: 'error_handling',
  synthetic: true,
  notice: 'Risposte HTTP sintetiche nello stile di Overpass; verificano la classificazione degli errori, non il servizio.',
  splits: {
    train: [e('pe-tr-01', 429, '', 'provider_rate_limited', true), e('pe-tr-02', 400, 'syntax error', 'provider_bad_request', false), e('pe-tr-03', 504, '', 'provider_timeout', true), e('pe-tr-04', 200, '{"remark":"runtime error: Query timed out"}', 'provider_timeout', true)],
    validation: [e('pe-va-01', 406, '', 'provider_rate_limited', true), e('pe-va-02', 403, '', 'provider_auth_failed', false), e('pe-va-03', 502, '', 'provider_unavailable', true), e('pe-va-04', 200, 'not json', 'provider_bad_response', false)],
    test: [e('pe-te-01', 429, 'rate_limited', 'provider_rate_limited', true), e('pe-te-02', 401, '', 'provider_auth_failed', false), e('pe-te-03', 500, '', 'provider_unavailable', true), e('pe-te-04', 200, '{"remark":"runtime error: out of memory"}', 'provider_unavailable', true)],
  },
}
