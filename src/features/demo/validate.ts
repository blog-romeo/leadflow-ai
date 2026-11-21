export type DemoErrors = Partial<Record<'name' | 'company' | 'email' | 'phone' | 'sector' | 'employees' | 'message' | 'contact_preference' | 'consent', string>>
/** Validazione minima lato browser; quella definitiva (e l'antispam) è sul server. */
export function validateDemoClient(v: Record<string, string>, consent: boolean): DemoErrors {
  const e: DemoErrors = {}
  if (v.name!.trim().length < 2) e.name = 'required'
  if (v.company!.trim().length < 2) e.company = 'required'
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(v.email!.trim())) e.email = 'invalid'
  if (v.sector!.trim().length < 2) e.sector = 'required'
  if (v.message!.trim().length < 10) e.message = 'too_short'
  if (v.contact_preference === 'phone' && !v.phone!.trim()) e.phone = 'required'
  if (!consent) e.consent = 'required'
  return e
}

