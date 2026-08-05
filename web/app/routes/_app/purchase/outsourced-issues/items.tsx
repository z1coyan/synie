import { createFileRoute } from '@tanstack/react-router'
import { SynieDataGrid, type ColumnOverride } from '~/components/synie-data-grid/SynieDataGrid'
import { AUDIT_DOC_STATUS_ENUM_COLORS, docActionVisible } from '~/lib/doc-status'
import { materialCellRender } from '~/components/synie-material-cell/MaterialCell'
import { useAuditDoc } from '../../scm/-audit-doc'
import { issueAuditConfig, useIssueDrawer } from './-issue-drawer'

export const Route = createFileRoute('/_app/purchase/outsourced-issues/items')({
  component: IssueItemsTab,
})

const GRID_OVERRIDES = {
  // 卡片:材料标题、协作方副标题、状态/数量/发料单号摘要
  companyId: { mobileRole: 'hide' },
  partyType: { label: '对手类型', mobileRole: 'hide' },
  issueStatus: {
    label: '发料状态',
    mobileRole: 'summary',
    enumColors: AUDIT_DOC_STATUS_ENUM_COLORS,
  },
  issueNo: { mobileRole: 'summary' },
  orderNo: { label: '订单号' },
  partyId: { mobileRole: 'subtitle' },
  // 材料列:全站统一富单元格(图纸缩略图+快照字段,编号点开物料速览);走行上快照,
  // 不 join inv.material(避免无物料读权限时整表失败);委外行无图纸挂接,缩略图回退物料当前图纸
  materialCode: {
    label: '材料',
    mobileRole: 'title',
    filterField: 'materialId',
    render: materialCellRender(),
  },
  unitName: { label: '单位' },
  qty: { mobileRole: 'summary' },
  baseQty: { label: '折算数量' },
  fromWarehouseId: { label: '调出仓' },
  outsourcedWarehouseId: { label: '外协仓' },
} satisfies Record<string, ColumnOverride>

// 列全走行上快照/计算字段,不点 materialId 等会触发嵌套授权的 fk
const GRID_COLUMNS = [
  'companyId',
  'issueNo',
  'issueDate',
  'issueStatus',
  'orderNo',
  'partyType',
  'partyId',
  'materialCode',
  'unitName',
  'qty',
  'baseQty',
  'fromWarehouseId',
  'outsourcedWarehouseId',
]

// 行编辑/审核整单仅草稿单放行(后端权威校验兜底,这里做体验层);删除不进条目视图
const ACTION_VISIBLE = docActionVisible({ edit: ['DRAFT'], auditDoc: ['DRAFT'] }, 'issueStatus')

function IssueItemsTab() {
  const openDrawer = useIssueDrawer()
  const { requestAudit, auditDialog } = useAuditDoc(issueAuditConfig)

  return (
    <>
      <SynieDataGrid
        resource="purOutsourcedIssueItems"
        columns={GRID_COLUMNS}
        overrides={GRID_OVERRIDES}
        defaultSort={{ column: 'issueDate', direction: 'descending' }}
        // 开抽屉需要母单 id;不进展示列,经 extraFields 取回(避免 issueId 为 undefined 过滤报错);
        // 材料富单元格所需快照字段与物料外键一并补取(发料行无 customerPartNo 快照,meta 无此字段)
        extraFields={['issueId', 'materialId', 'materialName', 'materialSpec']}
        createLabel="新建发料单"
        onCreate={() => openDrawer('create', null)}
        onView={(row) => {
          if (row.issueId == null || row.issueId === '') return
          openDrawer('view', {
            id: String(row.issueId),
            status: row.issueStatus,
          })
        }}
        onEdit={(row) => {
          if (row.issueId == null || row.issueId === '') return
          openDrawer(row.issueStatus === 'DRAFT' ? 'edit' : 'view', {
            id: String(row.issueId),
            status: row.issueStatus,
          })
        }}
        rowActions={[
          {
            key: 'auditDoc',
            label: '审核整单',
            capability: 'audit',
            onAction: (row, ctx) => {
              if (row.issueId == null || row.issueId === '') return
              requestAudit(String(row.issueId), ctx.refetch)
            },
          },
        ]}
        actionVisible={ACTION_VISIBLE}
      />
      {auditDialog}
    </>
  )
}
