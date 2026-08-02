import { createFileRoute } from '@tanstack/react-router'
import { Link } from '@heroui/react'
import {
  SynieDataGrid,
  type ColumnOverride,
} from '~/components/synie-data-grid/SynieDataGrid'
import { useFkPreview } from '~/components/synie-record-drawer/fk-preview'
import type { Row } from '~/components/synie-data-grid/types'
import { BomDrawerProvider, useBomDrawer } from './boms/-bom-drawer'

export const Route = createFileRoute('/_app/mfg/boms')({
  component: BomsPage,
})

const GRID_COLUMNS = ['code', 'materialId', 'planName', 'status', 'note']

function MaterialCell({ row }: { row: Row }) {
  const openPreview = useFkPreview()
  const id =
    row.materialId == null || row.materialId === ''
      ? null
      : String(row.materialId)
  const material = (row.material as Row | null | undefined) ?? null
  if (!id) return <span className="text-muted">—</span>
  if (!material) return <>{id.slice(0, 8)}</>
  const text = [material.code, material.name]
    .filter((s) => s != null && s !== '')
    .join('-')
  return (
    <Link
      onPress={() => openPreview('invMaterials', String(material.id ?? id))}
      className="inline-block max-w-80 cursor-pointer truncate align-bottom text-inherit underline-offset-2 hover:underline"
    >
      {text}
      {material.spec != null && material.spec !== '' && (
        <span className="text-muted">({String(material.spec)})</span>
      )}
    </Link>
  )
}

const GRID_OVERRIDES: Record<string, ColumnOverride> = {
  materialId: {
    label: '物料',
    mobileRole: 'title',
    render: (_value, row) => <MaterialCell row={row} />,
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
          joinFields={{ material: ['code', 'spec'] }}
          overrides={GRID_OVERRIDES}
          onView={(row) => openDrawer('view', row)}
          onCreate={() => openDrawer('create', null)}
          onEdit={(row) => openDrawer('edit', row)}
        />
      </div>
    </>
  )
}
