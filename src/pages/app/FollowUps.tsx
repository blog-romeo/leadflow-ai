import { useAuth } from '../../contexts/AuthContext'
import { useI18n } from '../../i18n'
import { PageHeader } from '../../components/ui/PageHeader'
import { InlineAlert } from '../../components/ui/States'
import { FollowUpList } from '../../features/sales/FollowUpList'
import { useSalesStatus } from '../../features/sales/useSalesStatus'

export default function FollowUps() {
  const { t } = useI18n()
  const { currentOrg } = useAuth()
  const orgId = currentOrg?.id ?? ''
  const { status } = useSalesStatus(orgId)
  return (
    <>
      <PageHeader title={t('sales.followUps.title')} subtitle={t('sales.followUps.subtitle')} />
      <div className="space-y-4">
        {status && !status.ai.configured && <InlineAlert tone="signal">{t('sales.banners.aiMissing')}</InlineAlert>}
        <FollowUpList orgId={orgId} aiReady={!!status?.ai.configured} />
      </div>
    </>
  )
}
