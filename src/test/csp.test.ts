import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

// Se lo script inline di index.html cambia, l'hash nella CSP di netlify.toml va aggiornato.
describe('Content-Security-Policy', () => {
  it('l’hash in netlify.toml corrisponde allo script inline di index.html', () => {
    const root = resolve(__dirname, '../..')
    const html = readFileSync(resolve(root, 'index.html'), 'utf8')
    const toml = readFileSync(resolve(root, 'netlify.toml'), 'utf8')
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? ''
    const hash = `sha256-${createHash('sha256').update(script).digest('base64')}`
    expect(toml).toContain(`'${hash}'`)
  })
  it('nessun segreto server-side referenziato nel codice client', () => {
    // Le variabili VITE_ finiscono nel bundle: nessuna deve contenere chiavi segrete.
    const env = readFileSync(resolve(__dirname, '../lib/env.ts'), 'utf8')
    expect(env).not.toMatch(/SERVICE_ROLE|OPENAI|STRIPE_SECRET/)
  })
})
