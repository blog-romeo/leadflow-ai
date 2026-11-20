import { LoaderCircle } from 'lucide-react'
import { useI18n } from '../../i18n'
import { InlineAlert } from '../../components/ui/States'
import { jobErrorReason } from './errors'
import type { JobState } from './jobs'

export function JobBanner({ job }: { job: JobState | null }) {
  const { t } = useI18n()
  if (!job) return null
  if (job.status === 'queued' || job.status === 'running') {
    return (
      <p role="status" className="flex items-center gap-2 text-sm text-muted">
        <LoaderCircle className="size-4 animate-spin" aria-hidden />
        {job.status === 'queued' ? t('sales.jobs.queued') : t('sales.jobs.running')}
      </p>
    )
  }
  if (job.status === 'failed') return <InlineAlert>{t('sales.jobs.failed', { reason: jobErrorReason(job.error, t) })}</InlineAlert>
  return null
}
