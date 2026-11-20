import { NavLink } from 'react-router-dom'
import { useI18n } from '../../i18n'
import { cn } from '../../lib/cn'

export function CrmTabs() {
  const { t } = useI18n()
  const cls = ({ isActive }: { isActive: boolean }) =>
    cn('rounded-md px-3 py-1.5 text-sm', isActive ? 'bg-flow-soft font-medium text-flow' : 'text-muted hover:text-ink')
  return (
    <nav aria-label={t('crm.title')} className="inline-flex rounded-[var(--radius-control)] border border-line p-0.5">
      <NavLink to="/app/crm" end className={cls}>
        {t('sales.pipeline.table')}
      </NavLink>
      <NavLink to="/app/crm/pipeline" className={cls}>
        {t('sales.pipeline.board')}
      </NavLink>
    </nav>
  )
}
