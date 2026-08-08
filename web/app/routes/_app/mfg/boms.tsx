import { createFileRoute } from '@tanstack/react-router'
import {
  SynieDataGrid,
  type ColumnOverride,
} from '~/components/synie-data-grid/SynieDataGrid'
import { materialCellRender } from '~/components/synie-material-cell/MaterialCell'
import { BomDrawerProvider, useBomDrawer } from './boms/-bom-drawer'

export const Route = createFileRoute('/_app/mfg/boms')({
  component: BomsPage,
})

// 物料按全站约定合并为单个富单元格(materialCode 列承载,名称/规格/客编为服务端 join 投影);
// BOM 头无图纸挂接,不传 drawingOwnerType,缩略图回退物料当前图纸
const GRID_COLUMNS = ['code', 'materialCode', 'planName', 'status', 'note']

const GRID_OVERRIDES: Record<string, ColumnOverride> = {
  materialCode: {
    label: '物料',
    mobileRole: 'title',
    filterField: 'materialId',
    render: materialCellRender(),
  },
  code: { mobileRole: 'subtitle' },
  planName: { mobileRole: 'summary' },
}

function BomsPage() {
  // urlSync:抽屉开/关/模式写入 ?record=&mode=,深链与刷新可寻址(见 useRecordDrawerUrl)
  return (
    <BomDrawerProvider urlSync>
      <BomsPageInner />
    </BomDrawerProvider>
  )
}

function BomsPageInner() {
  const openDrawer = useBomDrawer()

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">BOM</h1>
      <p className="mt-2 text-sm text-ink-500">
        物料清单(单层配方):同一物料可建多张,凭编号/方案名称区分;配料含净用量与损耗率;工艺路线可手录或从工艺模板带入;副产品为联产出声明。
      </p>

      <div className="mt-6">
        <SynieDataGrid
          resource="mfgBoms"
          columns={GRID_COLUMNS}
          overrides={GRID_OVERRIDES}
          onView={(row) => openDrawer('view', row)}
          onCreate={() => openDrawer('create', null)}
          onEdit={(row) => openDrawer('edit', row)}
        />
      </div>
    </>
  )
}
