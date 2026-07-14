import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from '@heroui/react'
import { gqlFetch } from '~/lib/graphql'
import { formatAmount } from '~/lib/amount'
import { SynieAttachmentPanel } from '~/components/synie-attachment-panel/SynieAttachmentPanel'
import { SynieDataGrid, type ColumnOverride } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import type { DrawerMode } from '~/components/synie-record-drawer/fields'
import type { Row } from '~/components/synie-data-grid/types'

export const Route = createFileRoute('/_app/finance/acceptance/bills')({
  component: BillsPage,
})

const UPDATE_BILL = `
  mutation ($id: ID!, $input: UpdateAccBillInput!) {
    updateAccBill(id: $id, input: $input) { result { id } errors { message } }
  }
`

// 建档随接收交易顺带完成(无 create mutation),本页仅票面修正;出票人/收款人/承兑人细项
// 不进表格(留在抽屉),票据种类/金额/到期日/承兑人/能否转让是台账最常核对的字段
const GRID_COLUMNS = ['billNo', 'billKind', 'faceAmount', 'issueDate', 'dueDate', 'acceptorName', 'transferable']

const GRID_OVERRIDES = {
  faceAmount: { render: (v: unknown) => formatAmount(v) },
} satisfies Record<string, ColumnOverride>

function BillsPage() {
  const [drawer, setDrawer] = useState<{ mode: DrawerMode; row: Row | null } | null>(null)
  const queryClient = useQueryClient()

  return (
    <>
      <p className="text-sm text-ink-500">
        承兑票据主档,建档随接收交易自动完成;此处仅供票面修正,有交易后到期日/票据包金额/能否转让锁定不可改。
      </p>

      <div className="mt-4">
        <SynieDataGrid
          resource="accBills"
          columns={GRID_COLUMNS}
          overrides={GRID_OVERRIDES}
          onView={(row) => setDrawer({ mode: 'view', row })}
          onEdit={(row) => setDrawer({ mode: 'edit', row })}
        />
      </div>

      <SynieRecordDrawer
        resource="accBills"
        label="承兑票据"
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(open) => !open && setDrawer(null)}
        // 表格列是白名单子集(无出票人/收款人/承兑人细项等),行数据不全;不传 row,走 rowId 自查完整记录
        rowId={drawer?.row?.id}
        contentClassName="w-full lg:w-[760px]"
        fields={{
          // 票号是票据身份,建档即定,不可改(后端 update 动作本就不收 bill_no)
          billNo: { order: -1, edit: 'readOnly' },
          billKind: { order: 0, cols: 6 },
          transferable: { order: 1, cols: 6 },
          issueDate: { order: 2, cols: 6 },
          dueDate: { order: 3, cols: 6 },
          faceAmount: { order: 4, cols: 6 },
          acceptanceDate: { order: 5, cols: 6 },
          // 出票人/收款人/承兑人四件套(名称/账号/开户行/开户行联行号),两列排
          drawerName: { order: 6, cols: 6, label: '出票人名称' },
          drawerAccount: { order: 7, cols: 6, label: '出票人账号' },
          drawerBankName: { order: 8, cols: 6, label: '出票人开户行' },
          drawerBankNo: { order: 9, cols: 6, label: '出票人开户行联行号' },
          payeeName: { order: 10, cols: 6, label: '收款人名称' },
          payeeAccount: { order: 11, cols: 6, label: '收款人账号' },
          payeeBankName: { order: 12, cols: 6, label: '收款人开户行' },
          payeeBankNo: { order: 13, cols: 6, label: '收款人开户行联行号' },
          acceptorName: { order: 14, cols: 6, label: '承兑人名称' },
          acceptorAccount: { order: 15, cols: 6, label: '承兑人账号' },
          acceptorBankName: { order: 16, cols: 6, label: '承兑人开户行' },
          acceptorBankNo: { order: 17, cols: 6, label: '承兑人开户行联行号' },
          remarks: { order: 18 },
        }}
        // create 态在本页不存在(无 onCreate),票面影像 create 态不渲染无需提示
        extraContent={(mode, row) => (
          <SynieAttachmentPanel
            ownerType="acc_bill"
            ownerId={row?.id as string | undefined}
            category="original"
            readonly={mode === 'view'}
          />
        )}
        onEdit={() => setDrawer((d) => (d ? { ...d, mode: 'edit' } : d))}
        onSubmit={async (values, _mode) => {
          const data = await gqlFetch<{ updateAccBill: { errors: { message: string }[] | null } }>(UPDATE_BILL, {
            id: drawer!.row!.id,
            input: values,
          })
          if (data.updateAccBill.errors && data.updateAccBill.errors.length > 0) {
            throw new Error(data.updateAccBill.errors.map((e) => e.message).join('; '))
          }
          toast.success('票据已更新')
          queryClient.invalidateQueries({ queryKey: ['gridRows', 'accBills'] })
        }}
      />
    </>
  )
}
