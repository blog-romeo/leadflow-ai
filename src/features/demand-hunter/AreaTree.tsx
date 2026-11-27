import { useState } from 'react'
import { ChevronRight, Sparkles } from 'lucide-react'
import { cn } from '../../lib/cn'
import { useI18n } from '../../i18n'
import { Badge } from '../../components/ui/Badge'
import type { AreaNode } from './types'

/** Albero delle aree commerciali (areas.py): aprire è gratis; i termini scoperti con Google sono segnati. */
export function AreaTree({ root, selected, onSelect }: { root: AreaNode; selected: string | null; onSelect: (label: string) => void }) {
  return (
    <ul className="space-y-1" role="tree" aria-label={root.label}>
      {root.children.map((c) => (
        <TreeItem key={c.label} node={c} depth={0} selected={selected} onSelect={onSelect} />
      ))}
    </ul>
  )
}

function TreeItem({ node, depth, selected, onSelect }: { node: AreaNode; depth: number; selected: string | null; onSelect: (label: string) => void }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const hasKids = node.children.length > 0
  const isSel = selected?.toLowerCase() === node.label.toLowerCase()
  return (
    <li role="treeitem" aria-expanded={hasKids ? open : undefined} aria-selected={isSel}>
      <div className={cn('flex items-center gap-1 rounded-[var(--radius-control)] pr-2', isSel ? 'bg-flow-soft' : 'hover:bg-surface-2')} style={{ paddingLeft: `${depth * 16}px` }}>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          disabled={!hasKids}
          aria-label={t('demandHunter.market.toggle', { label: node.label })}
          className="grid size-7 shrink-0 place-items-center text-muted disabled:invisible"
        >
          <ChevronRight className={cn('size-4 transition-transform', open && 'rotate-90')} aria-hidden />
        </button>
        <button type="button" onClick={() => onSelect(node.label)} className={cn('min-w-0 flex-1 truncate py-1.5 text-left text-sm', isSel ? 'font-semibold text-flow' : 'text-ink')}>
          {node.label}
        </button>
        {node.source === 'autocomplete' && (
          <Badge tone="signal">
            <Sparkles className="size-3" aria-hidden />
            {t('demandHunter.market.discovered')}
          </Badge>
        )}
        {node.hunted > 0 && <span className="shrink-0 text-xs text-muted">{t('demandHunter.market.hunted', { n: node.hunted })}</span>}
        {node.leads > 0 && <Badge tone="ok">{t('demandHunter.market.leads', { n: node.leads })}</Badge>}
      </div>
      {hasKids && open && (
        <ul role="group" className="space-y-0.5">
          {node.children.map((c) => (
            <TreeItem key={c.label} node={c} depth={depth + 1} selected={selected} onSelect={onSelect} />
          ))}
        </ul>
      )}
    </li>
  )
}
