import { useState, type FormEvent } from 'react'
import { useI18n } from '../../i18n'
import { Dialog } from '../../components/ui/Dialog'
import { Field, Select } from '../../components/ui/Field'
import { Button } from '../../components/ui/Button'
import { InlineAlert } from '../../components/ui/States'
import { apiErrorMessage, apiFetch } from '../../lib/api'
import { parseCsv, toRows } from './csv'

type Basis = 'legitimate_interest' | 'consent' | 'contract' | 'public_professional_data'

export function CsvImportDialog({ open, orgId, onClose, onImported }: { open: boolean; orgId: string; onClose: () => void; onImported: (searchId: string, message: string) => void }) {
  const { t } = useI18n()
  const [fileName, setFileName] = useState('')
  const [rows, setRows] = useState<Record<string, string>[]>([])
  const [nameCol, setNameCol] = useState<string | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [sourceName, setSourceName] = useState('')
  const [basis, setBasis] = useState<Basis>('legitimate_interest')
  const [confirmed, setConfirmed] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onFile(file: File | undefined) {
    setFileError(null)
    setRows([])
    if (!file) return
    if (file.size > 2_000_000) return setFileError(t('leadFinder.csv.tooMany'))
    const text = await file.text()
    const table = parseCsv(text)
    const { rows: parsed, columns } = toRows(table)
    if (columns.company_name === undefined) return setFileError(t('leadFinder.csv.noNameColumn'))
    if (parsed.length > 1000) return setFileError(t('leadFinder.csv.tooMany'))
    setFileName(file.name)
    setNameCol(table[0]?.[columns.company_name] ?? null)
    setRows(parsed.filter((r) => r.company_name))
    if (!sourceName) setSourceName(file.name.replace(/\.csv$/i, ''))
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (!rows.length || sourceName.trim().length < 2 || !confirmed) return
    setBusy(true)
    const searchId = crypto.randomUUID()
    try {
      const res = await apiFetch<{ counts: { valid: number; new: number; invalid: number }; invalid: { row: number }[] }>('/api/lead-finder/import', {
        method: 'POST',
        body: {
          organization_id: orgId,
          search_id: searchId,
          file_name: fileName,
          source: { name: sourceName.trim(), legal_basis: basis, confirmed_lawful: true },
          rows,
        },
      })
      const msg = [
        t('leadFinder.csv.result', { valid: res.counts.valid, new: res.counts.new, invalid: res.counts.invalid }),
        res.invalid.length ? t('leadFinder.csv.invalidRows', { rows: res.invalid.map((r) => r.row).join(', ') }) : '',
      ]
        .filter(Boolean)
        .join(' ')
      onImported(searchId, msg)
    } catch (err) {
      setError(apiErrorMessage(err, t))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('leadFinder.csv.title')}
      closeLabel={t('common.cancel')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" form="csv-import" loading={busy} disabled={!rows.length || !confirmed || sourceName.trim().length < 2}>
            {t('leadFinder.csv.submit')}
          </Button>
        </>
      }
    >
      <form id="csv-import" onSubmit={submit} className="space-y-4">
        <p className="text-sm text-muted">{t('leadFinder.csv.body')}</p>
        {error && <InlineAlert>{error}</InlineAlert>}
        <div className="space-y-1.5">
          <label htmlFor="csv-file" className="block text-sm font-medium">
            {t('leadFinder.csv.file')}
          </label>
          <input
            id="csv-file"
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => void onFile(e.target.files?.[0])}
            className="block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-surface-2 file:px-3 file:py-2 file:text-sm file:font-medium"
            aria-describedby="csv-hint"
          />
          <p id="csv-hint" className="text-xs text-muted">
            {t('leadFinder.csv.fileHint')}
          </p>
          {fileError && (
            <p role="alert" className="text-xs font-medium text-danger">
              {fileError}
            </p>
          )}
          {rows.length > 0 && <p className="text-xs font-medium text-ok">{t('leadFinder.csv.preview', { rows: rows.length, column: nameCol ?? '' })}</p>}
        </div>
        <Field label={t('leadFinder.csv.sourceName')} placeholder={t('leadFinder.csv.sourceNamePh')} value={sourceName} onChange={(e) => setSourceName(e.target.value)} maxLength={160} required />
        <Select label={t('leadFinder.csv.legalBasis')} value={basis} onChange={(e) => setBasis(e.target.value as Basis)}>
          {(['legitimate_interest', 'consent', 'contract', 'public_professional_data'] as const).map((b) => (
            <option key={b} value={b}>
              {t(`leadFinder.csv.basis.${b}`)}
            </option>
          ))}
        </Select>
        <label className="flex items-start gap-2.5 text-sm">
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="mt-0.5 size-4 accent-[var(--lf-flow)]" />
          {t('leadFinder.csv.confirm')}
        </label>
      </form>
    </Dialog>
  )
}
