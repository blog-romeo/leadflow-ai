#!/usr/bin/env node
/**
 * Controllo dei segreti nei file versionati e non ignorati (Prompt 10, usato dalla CI).
 * Cerca chiavi reali per forma (Stripe, OpenAI, Supabase service role JWT, Resend, Google, GitHub, chiavi
 * private) e file .env versionati. Esce con codice 1 se trova qualcosa. Una riga di test che contiene
 * deliberatamente un valore finto può essere esclusa con il commento `secret-scan: allow`.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

export const PATTERNS = [
  ['stripe_secret', /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}/],
  ['stripe_test_secret', /\b(?:sk|rk)_test_[A-Za-z0-9]{24,}/],
  ['stripe_webhook', /\bwhsec_[A-Za-z0-9]{24,}/],
  ['openai', /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/],
  ['resend', /\bre_[A-Za-z0-9]{24,}/],
  ['google', /\bAIza[0-9A-Za-z_-]{35}/],
  ['github', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})/],
  ['private_key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
]

export function scanText(text, file) {
  const hits = []
  text.split('\n').forEach((line, i) => {
    if (line.includes('secret-scan: allow')) return
    for (const [name, re] of PATTERNS) if (re.test(line)) hits.push({ file, line: i + 1, kind: name })
  })
  return hits
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' }).split('\0').filter(Boolean)
  const hits = []
  for (const f of files) {
    if (/(^|\/)\.env(\.|$)/.test(f) && !f.endsWith('.env.example')) hits.push({ file: f, line: 0, kind: 'env_file_committed' })
    if (/\.(png|jpe?g|gif|webp|ico|woff2?|ttf|zip|pdf)$/i.test(f) || f === 'package-lock.json') continue
    let text
    try {
      text = readFileSync(f, 'utf8')
    } catch {
      continue
    }
    hits.push(...scanText(text, f))
  }
  // Il valore trovato NON viene stampato: solo file, riga e tipo.
  for (const h of hits) console.log(`✗ ${h.file}:${h.line} possibile segreto (${h.kind})`)
  console.log(hits.length ? `\n${hits.length} possibili segreti: rimuoverli e ruotare le chiavi.` : 'Nessun segreto trovato nei file versionati.')
  process.exit(hits.length ? 1 : 0)
}
