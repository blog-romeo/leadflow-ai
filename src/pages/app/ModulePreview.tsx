import { Check } from 'lucide-react'
import { Link } from 'react-router-dom'
import { buttonClasses } from '../../components/ui/Button'
import { useI18n } from '../../i18n'
import { MODULES } from '../../config/modules'
import { PageHeader } from '../../components/ui/PageHeader'
import { Panel } from '../../components/ui/Panel'
import { Badge } from '../../components/ui/Badge'
import type { ReactNode } from 'react'

/**
 * Pagina per i moduli non ancora attivi: spiega cosa faranno, senza simulare dati o funzioni.
 */
export default function ModulePreview({ moduleKey, children }: { moduleKey: string; children?: ReactNode }) {
  const { t, list } = useI18n()
  const mod = MODULES.find((m) => m.key === moduleKey)
  if (!mod?.previewKey) return null
  const base = `modules.${mod.previewKey}`
  const Icon = mod.icon
  return (
    <>
      <PageHeader
        title={t(`${base}.title`)}
        actions={mod.status === 'available' ? <Badge tone="ok">{t('common.available')}</Badge> : <Badge tone="signal">{t('common.inPreparation')}</Badge>}
      />
      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <Panel>
          <div className="flex gap-4">
            <span className="grid size-11 shrink-0 place-items-center rounded-full bg-flow-soft text-flow">
              <Icon className="size-5" aria-hidden />
            </span>
            <div>
              <p className="max-w-prose">{t(`${base}.body`)}</p>
              {mod.status === 'preparation' && <p className="mt-4 text-sm text-muted">{t('modules.notice')}</p>}
              {mod.usedIn && (
                <Link to={mod.usedIn} className={buttonClasses('primary', 'md', 'mt-4')}>
                  {t('modules.openLeadFinder')}
                </Link>
              )}
            </div>
          </div>
        </Panel>
        <Panel title={mod.status === 'available' ? t('modules.featuresTitle') : t('modules.plannedTitle')}>
          <ul className="space-y-2.5 text-sm">
            {list(`${base}.points`).map((p) => (
              <li key={p} className="flex gap-2.5">
                <Check className="mt-0.5 size-4 shrink-0 text-flow" aria-hidden />
                {p}
              </li>
            ))}
          </ul>
        </Panel>
      </div>
      {children && <div className="mt-6">{children}</div>}
    </>
  )
}
