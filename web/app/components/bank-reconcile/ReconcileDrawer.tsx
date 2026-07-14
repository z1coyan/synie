import { useState } from 'react'
import { AlertDialog, Button, toast } from '@heroui/react'
import { useQuery } from '@tanstack/react-query'
import { gqlFetch } from '~/lib/graphql'
import { SynieDataGrid } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import type { Row } from '~/components/synie-data-grid/types'

const DESTROY_RECONCILIATION = `
  mutation ($id: ID!) {
    destroyAccBankReconciliation(id: $id) { errors { message } }
  }
`

// 银行账户绑定科目:严格对账的前提,未绑定时隐藏表单并引导去绑定
const BANK_ACCOUNT_LEDGER = `
  query ($id: ID!) {
    accBankAccounts(filter: {id: {eq: $id}}, limit: 1, offset: 0) { results { id accountId } }
  }
`

export interface ReconcileDrawerProps {
  txn: Row | null
  onOpenChange: (open: boolean) => void
  /** 任一对账变更后回调(父列表刷新) */
  onChanged: () => void
}

export function ReconcileDrawer({ txn, onOpenChange, onChanged }: ReconcileDrawerProps) {
  // 对账增删后 bump:key 变化整体重挂,概要派生列与关联列表一起刷新
  const [version, setVersion] = useState(0)

  const bump = () => {
    setVersion((v) => v + 1)
    onChanged()
  }

  return (
    <SynieRecordDrawer
      key={`${txn?.id ?? ''}:${version}`}
      resource="accBankTransactions"
      label="流水对账"
      mode="view"
      isOpen={txn !== null}
      onOpenChange={onOpenChange}
      // 行数据来自列表白名单不全,按 id 自查完整记录(含派生列)
      rowId={txn?.id}
      contentClassName="w-full lg:w-[880px]"
      exclude={['balance', 'counterpartyAccount', 'note', 'insertedAt', 'updatedAt']}
      extraContent={(_mode, row) => (row ? <ReconcileSection txn={row} onChanged={bump} /> : null)}
    />
  )
}

function ReconcileSection({ txn, onChanged }: { txn: Row; onChanged: () => void }) {
  const [unlink, setUnlink] = useState<Row | null>(null)
  const [unlinking, setUnlinking] = useState(false)

  const ledger = useQuery({
    queryKey: ['bankAccountLedger', txn.bankAccountId],
    queryFn: () =>
      gqlFetch<{ accBankAccounts: { results: { id: string; accountId: string | null }[] } }>(
        BANK_ACCOUNT_LEDGER,
        { id: txn.bankAccountId }
      ).then((d) => d.accBankAccounts.results[0]?.accountId ?? null),
  })

  const confirmUnlink = async () => {
    if (!unlink) return
    setUnlinking(true)
    try {
      const data = await gqlFetch<{
        destroyAccBankReconciliation: { errors: { message: string }[] | null }
      }>(DESTROY_RECONCILIATION, { id: unlink.id })
      if (data.destroyAccBankReconciliation.errors?.length) {
        throw new Error(data.destroyAccBankReconciliation.errors.map((e) => e.message).join('; '))
      }
      toast.success('已解除对账')
      setUnlink(null)
      onChanged()
    } catch (e) {
      toast.danger('解除失败', { description: (e as Error).message })
    } finally {
      setUnlinking(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">对账关联记录</h3>
        <SynieDataGrid
          resource="accBankReconciliations"
          columns={['journalId', 'amount', 'insertedAt']}
          fixedFilter={{ bankTransactionId: { eq: txn.id } }}
          rowActions={[
            { key: 'unlink', label: '解除', isDanger: true, onAction: (row) => setUnlink(row) },
          ]}
        />
      </section>

      {ledger.data === null && !ledger.isPending && (
        <p className="text-sm text-danger">该银行账户未绑定会计科目,请先在「银行账户」中绑定后再对账。</p>
      )}
      {/* Task 8:关联已有凭证 / 快速新增凭证两个表单挂在这里(ledger.data 为科目 id 时渲染) */}

      <AlertDialog.Backdrop isOpen={unlink !== null} onOpenChange={(open) => !open && setUnlink(null)}>
        <AlertDialog.Container>
          {/* 退场动画期间 unlink 已清空,显式 aria-label 防 RAC 无标题警告 */}
          <AlertDialog.Dialog className="sm:max-w-[400px]" aria-label="确认解除对账">
            {unlink && (
              <>
                <AlertDialog.Header>
                  <AlertDialog.Icon status="danger" />
                  <AlertDialog.Heading>确认解除对账?</AlertDialog.Heading>
                </AlertDialog.Header>
                <AlertDialog.Body>
                  <p>将解除该流水与凭证的对账关联(金额 {String(unlink.amount)}),此操作不影响凭证本身。</p>
                </AlertDialog.Body>
                <AlertDialog.Footer>
                  <Button slot="close" variant="tertiary" isDisabled={unlinking}>取消</Button>
                  <Button variant="danger" isPending={unlinking} onPress={confirmUnlink}>解除</Button>
                </AlertDialog.Footer>
              </>
            )}
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </div>
  )
}
