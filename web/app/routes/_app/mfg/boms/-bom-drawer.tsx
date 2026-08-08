import {
  useEffect,
  useState,
  type ReactNode,
} from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Button, Modal, toast } from '@heroui/react'
import { SynieEditableTable } from '~/components/synie-editable-table/SynieEditableTable'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { drawerConfig } from '~/components/synie-record-drawer/extension-drawer-props'
import type { DrawerMode } from '~/components/synie-record-drawer/fields'
import { MaterialUnitSelect } from '~/components/synie-material-unit-select/MaterialUnitSelect'
import { MaterialCell } from '~/components/synie-material-cell/MaterialCell'
import { RemoteSelect } from '~/components/synie-remote-select/RemoteSelect'
import { resolveSource } from '~/components/synie-remote-select/remote-query'
import { useRemoteRecords } from '~/components/synie-remote-select/use-remote'
import {
  applyRouteTemplate as applyBomRouteTemplate,
  bomByproductClient,
  bomClient,
  bomComponentClient,
  bomRouteClient,
} from '~/lib/resources/manufacturing'
import { resourceLabel } from '~/lib/resources/catalog'
import type { Row } from '~/components/synie-data-grid/types'
import { persistChildRows } from '~/lib/resources/persist-child-rows'
import { resourceBindingFor } from '~/lib/resources/registry'
import { toastError } from '~/lib/toast'
import {
  createDocumentDrawerOpenBridge,
  useDocumentDrawer,
} from '~/lib/use-document-drawer'

/**
 * 配料/副产品物料列:全站统一富单元格(图纸缩略图+编号/名称/规格/客编)。
 * 已持久化行经服务端 join 投影自带四字段;本地新录行(或改物料后投影键被
 * transformItem 清掉)按 materialId 反查物料主数据(FkText 同路径,id 级缓存去重)。
 */
function BomLineMaterialCell({ row }: { row: Row }) {
  const materialId =
    row.materialId == null || row.materialId === '' ? null : String(row.materialId)
  const missing = materialId != null && row.materialCode == null
  const resolved = useRemoteRecords(
    missing ? resolveSource({ resource: 'invMaterials' }) : null,
    missing ? [materialId] : [],
  )
  const live = missing
    ? (resolved.data ?? []).find((r) => String(r.id) === materialId)
    : null
  const merged: Row = missing
    ? {
        ...row,
        materialCode: live?.code ?? null,
        materialName: live?.name ?? null,
        materialSpec: live?.spec ?? null,
        customerPartNo: live?.customerPartNo ?? null,
      }
    : row
  return <MaterialCell row={merged} />
}

const bomLineMaterialOverrides = {
  materialId: {
    label: '物料',
    className: 'min-w-[12rem] max-w-[18rem]',
    render: (_value: unknown, row: Row) => <BomLineMaterialCell row={row} />,
  },
}

/** 改物料后清掉行上旧投影键,单元格改按新 materialId 反查,避免残留改前物料文案 */
function clearMaterialProjectionOnChange(
  values: Record<string, unknown>,
  editing: Row | null,
): Record<string, unknown> {
  if (editing && String(editing.materialId ?? '') !== String(values.materialId ?? '')) {
    return {
      ...values,
      materialCode: undefined,
      materialName: undefined,
      materialSpec: undefined,
      customerPartNo: undefined,
    }
  }
  return values
}

// mutation input 只收行自身字段,行上挂的 material/unit/operation join 对象不进 payload
function componentInput(row: Row) {
  return {
    materialId: row.materialId,
    unitId: row.unitId,
    quantity: row.quantity,
    lossRate: row.lossRate ?? null,
    note: row.note ?? null,
  }
}

function routeInput(row: Row) {
  return {
    operationId: row.operationId,
    seq: row.seq,
    requirement: row.requirement ?? null,
    isOutsourced: row.isOutsourced,
  }
}

function byproductInput(row: Row) {
  return {
    materialId: row.materialId,
    unitId: row.unitId,
    quantity: row.quantity,
    note: row.note ?? null,
  }
}

async function persistComponents(
  bomId: string,
  current: Row[],
  snapshot: Row[],
): Promise<string[]> {
  return persistChildRows({
    current,
    snapshot,
    client: bomComponentClient,
    parentIdField: 'bomId',
    parentId: bomId,
    compareKeys: ['materialId', 'unitId', 'quantity', 'lossRate', 'note'],
    inputOf: componentInput,
    rowLabel: (row) =>
      String((row.material as Row | undefined)?.name ?? '配料行'),
  })
}

async function persistRoutes(
  bomId: string,
  current: Row[],
  snapshot: Row[],
): Promise<string[]> {
  return persistChildRows({
    current,
    snapshot,
    client: bomRouteClient,
    parentIdField: 'bomId',
    parentId: bomId,
    compareKeys: ['operationId', 'seq', 'requirement', 'isOutsourced'],
    inputOf: routeInput,
    rowLabel: (row) =>
      String((row.operation as Row | undefined)?.name ?? '路线行'),
  })
}

async function persistByproducts(
  bomId: string,
  current: Row[],
  snapshot: Row[],
): Promise<string[]> {
  return persistChildRows({
    current,
    snapshot,
    client: bomByproductClient,
    parentIdField: 'bomId',
    parentId: bomId,
    compareKeys: ['materialId', 'unitId', 'quantity', 'note'],
    inputOf: byproductInput,
    rowLabel: (row) =>
      String((row.material as Row | undefined)?.name ?? '副产品行'),
  })
}

export interface OpenBomDrawerOptions {
  /** create 态预填/锁定母物料（工单内嵌创建用） */
  materialId?: string | null
  /** 锁定母物料不可改 */
  lockMaterial?: boolean
  /**
   * create 时 BOM 状态。工单引用需 ACTIVE；主数据页默认草稿。
   */
  createStatus?: 'DRAFT' | 'ACTIVE'
  /** create 成功（头+明细已尽量落库）后回调，供工单 form 回填 bomId */
  onCreated?: (bom: Row) => void
}

export type OpenBomDrawer = (
  mode: DrawerMode,
  row: Row | null,
  options?: OpenBomDrawerOptions,
) => void

const {
  useOpen: useBomDrawer,
  Provider: BomDrawerOpenProvider,
} = createDocumentDrawerOpenBridge<OpenBomDrawer>()
export { useBomDrawer }


/** 三个子表行集合的装载快照(骨架 loadDraft 的返回形) */
interface BomLinesDraft {
  components: Row[]
  routes: Row[]
  byproducts: Row[]
}

/**
 * 完整 BOM 创建/编辑抽屉（配料/路线/副产品 + 模板带入）。
 * BOM 列表页与生产工单「新建 BOM」共用，避免工单侧再实现一套表单。
 *
 * @param urlSync 列表页传 true:抽屉开/关/模式走 URL search(?record=&mode=),
 *   深链/刷新/后退可寻址。工单页内嵌创建保持默认 false(纯本地态,不写宿主 URL)。
 */
export function BomDrawerProvider({
  children,
  urlSync = false,
}: {
  children: ReactNode
  urlSync?: boolean
}) {
  // 单据抽屉骨架:双态状态机、URL 身份→行集合装载(竞态安全)、深链补拉全部收口进 hook
  const drawer = useDocumentDrawer<BomLinesDraft>({
    resource: 'mfgBoms',
    urlSync,
    loadDraft: async (bomId) => {
      const filter = {
        bomId: {
          kind: 'fk' as const,
          op: 'in' as const,
          values: [bomId],
          labels: [],
        },
      }
      const [componentResult, routeResult, byproductResult] = await Promise.all([
        bomComponentClient.query({ limit: 200, offset: 0, filter }),
        bomRouteClient.query({
          limit: 200,
          offset: 0,
          filter,
          sort: { column: 'seq', direction: 'ascending' },
        }),
        bomByproductClient.query({ limit: 200, offset: 0, filter }),
      ])
      return {
        components: componentResult.results,
        routes: routeResult.results,
        byproducts: byproductResult.results,
      }
    },
  })
  const { isOpen, mode, rowId } = drawer
  // options 不可 URL 化,始终本地(骨架只收管道,options 属 BOM 声明)
  const [options, setOptions] = useState<OpenBomDrawerOptions | undefined>()
  const [components, setComponents] = useState<Row[]>([])
  const [componentsSnapshot, setComponentsSnapshot] = useState<Row[]>([])
  const [routes, setRoutes] = useState<Row[]>([])
  const [routesSnapshot, setRoutesSnapshot] = useState<Row[]>([])
  const [byproducts, setByproducts] = useState<Row[]>([])
  const [byproductsSnapshot, setByproductsSnapshot] = useState<Row[]>([])
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false)
  const [templateId, setTemplateId] = useState<string | null>(null)
  const [applying, setApplying] = useState(false)
  const queryClient = useQueryClient()

  // 草稿 → 行集合派生:draft 变化(含关闭/新建清空)时初始化三个子表及其保存比对基线
  useEffect(() => {
    const lines: BomLinesDraft = drawer.draft ?? {
      components: [],
      routes: [],
      byproducts: [],
    }
    setComponents(lines.components)
    setComponentsSnapshot(lines.components)
    setRoutes(lines.routes)
    setRoutesSnapshot(lines.routes)
    setByproducts(lines.byproducts)
    setByproductsSnapshot(lines.byproducts)
  }, [drawer.draft, drawer.generation]) // generation 覆盖 create/关闭的 null→null(draft 引用不变也需重置)

  // URL 后退关抽屉时清本地 options
  useEffect(() => {
    if (!isOpen) setOptions(undefined)
  }, [isOpen])

  const closeDrawer = () => {
    setOptions(undefined)
    drawer.close()
  }

  const openDrawer: OpenBomDrawer = (nextMode, row, nextOptions) => {
    setOptions(nextOptions)
    drawer.open(nextMode, row)
  }

  async function applyRouteTemplate() {
    const bomId = rowId
    if (!bomId || templateId == null) return
    setApplying(true)
    try {
      await applyBomRouteTemplate(bomId, templateId)
      const result = await bomRouteClient.query({
        limit: 200,
        offset: 0,
        filter: {
          bomId: {
            kind: 'fk',
            op: 'in',
            values: [bomId],
            labels: [],
          },
        },
        sort: { column: 'seq', direction: 'ascending' },
      })
      setRoutes(result.results)
      setRoutesSnapshot(result.results)
      toast.success('已从模板带入工艺路线')
      setTemplatePickerOpen(false)
      setTemplateId(null)
    } catch (e) {
      toastError('从模板带入失败')(e)
    } finally {
      setApplying(false)
    }
  }

  const opts = options
  const lockedMaterialId =
    opts?.lockMaterial && opts.materialId
      ? String(opts.materialId)
      : null
  const prefillMaterialId =
    lockedMaterialId ??
    (opts?.materialId ? String(opts.materialId) : null)

  const baseConfig = drawerConfig('mfgBoms')
  const fields = {
    ...baseConfig.fields,
    materialId: {
      ...baseConfig.fields?.materialId,
      // BOM 母物料限库存物料(虚拟/资产无实物);后端权威拦截兜底
      remote: { filterState: { materialType: { kind: 'enum' as const, values: ['STOCK'] } } },
      ...(prefillMaterialId
        ? { defaultValue: prefillMaterialId }
        : {}),
      ...(lockedMaterialId
        ? {
            edit: 'readOnly' as const,
            placeholder: '锁定为工单物料',
          }
        : {}),
    },
  }

  return (
    <BomDrawerOpenProvider value={openDrawer}>
      {children}

      <SynieRecordDrawer
        resource="mfgBoms"
        {...baseConfig}
        fields={fields}
        mode={mode}
        isOpen={isOpen}
        onOpenChange={(open) => {
          if (!open) closeDrawer()
        }}
        rowId={rowId}
        onEdit={() => drawer.setMode('edit')}
        // 配料挂基本信息首 tab（字段栅格之后）；路线/副产品仍分 tab
        extraContent={(m) => (
          <SynieEditableTable
            resource="mfgBomComponents"
            label="配料"
            items={components}
            onChange={setComponents}
            readOnly={m === 'view' || (m !== 'create' && !drawer.detailLoaded)}
            exclude={['bomId']}
            columns={['materialId', 'unitId', 'quantity', 'lossRate', 'note']}
            overrides={bomLineMaterialOverrides}
            transformItem={clearMaterialProjectionOnChange}
            fields={{
              materialId: {
                order: 0,
                required: true,
                // 配料/副产品限库存物料(虚拟/资产无实物);后端权威拦截兜底
                remote: { filterState: { materialType: { kind: 'enum', values: ['STOCK'] } } },
                effects: () => ({ unitId: null }),
              },
              unitId: {
                order: 1,
                required: true,
                input: ({
                  value,
                  onChange,
                  isDisabled,
                  values: itemValues,
                }) => (
                  <MaterialUnitSelect
                    materialId={
                      itemValues.materialId == null
                        ? null
                        : String(itemValues.materialId)
                    }
                    value={value}
                    onChange={onChange}
                    isDisabled={isDisabled}
                  />
                ),
              },
              quantity: {
                order: 2,
                required: true,
                label: '净用量',
                placeholder: '每 1 默认单位母物料',
              },
              lossRate: {
                order: 3,
                label: '损耗率',
                placeholder: '空即无损耗,如 0.05',
              },
              note: { order: 4 },
            }}
            validateItem={(vals) => {
              if (!vals.materialId) return '请选择物料'
              if (!(Number(vals.quantity) > 0)) return '净用量必须大于 0'
              if (vals.lossRate != null && Number(vals.lossRate) < 0)
                return '损耗率不能为负'
            }}
          />
        )}
        tabExtraContent={{
          routes: (m) => (
            <SynieEditableTable
              resource="mfgBomRoutes"
              label="工艺路线"
              items={routes}
              onChange={setRoutes}
              readOnly={m === 'view' || (m !== 'create' && !drawer.detailLoaded)}
              exclude={['bomId']}
              columns={['seq', 'operationId', 'requirement', 'isOutsourced']}
              fields={{
                operationId: { order: 0, required: true },
                seq: {
                  order: 1,
                  required: true,
                  placeholder: '工序顺序,如 10',
                },
                requirement: { order: 2 },
                isOutsourced: { order: 3, label: '外协', defaultValue: false },
              }}
              toolbar={
                m === 'edit' ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    isDisabled={!drawer.detailLoaded || routes.length > 0}
                    onPress={() => {
                      setTemplateId(null)
                      setTemplatePickerOpen(true)
                    }}
                  >
                    从模板带入
                  </Button>
                ) : m === 'create' ? (
                  <span className="self-center text-xs text-muted">
                    保存 BOM 后可从模板带入
                  </span>
                ) : undefined
              }
              validateItem={(vals) => {
                if (!vals.operationId) return '请选择工序'
                if (
                  !(
                    Number.isInteger(Number(vals.seq)) && Number(vals.seq) > 0
                  )
                )
                  return '序号必须为正整数'
              }}
            />
          ),
          byproducts: (m) => (
            <SynieEditableTable
              resource="mfgBomByproducts"
              label="副产品"
              items={byproducts}
              onChange={setByproducts}
              readOnly={m === 'view' || (m !== 'create' && !drawer.detailLoaded)}
              exclude={['bomId']}
              columns={['materialId', 'unitId', 'quantity', 'note']}
              overrides={bomLineMaterialOverrides}
              transformItem={clearMaterialProjectionOnChange}
              fields={{
                materialId: {
                  order: 0,
                  required: true,
                  // 配料/副产品限库存物料(虚拟/资产无实物);后端权威拦截兜底
                  remote: { filterState: { materialType: { kind: 'enum', values: ['STOCK'] } } },
                  effects: () => ({ unitId: null }),
                },
                unitId: {
                  order: 1,
                  required: true,
                  input: ({
                    value,
                    onChange,
                    isDisabled,
                    values: itemValues,
                  }) => (
                    <MaterialUnitSelect
                      materialId={
                        itemValues.materialId == null
                          ? null
                          : String(itemValues.materialId)
                      }
                      value={value}
                      onChange={onChange}
                      isDisabled={isDisabled}
                    />
                  ),
                },
                quantity: {
                  order: 2,
                  required: true,
                  label: '产出量',
                  placeholder: '每 1 默认单位母物料',
                },
                note: { order: 3 },
              }}
              validateItem={(vals) => {
                if (!vals.materialId) return '请选择物料'
                if (!(Number(vals.quantity) > 0)) return '产出量必须大于 0'
              }}
            />
          ),
        }}
        onSubmit={async (values, submitMode) => {
          if (submitMode === 'create') {
            const createStatus = opts?.createStatus ?? 'DRAFT'
            const created = (await bomClient.create({
              ...values,
              // 锁定物料时表单可能只读，确保写入
              materialId: lockedMaterialId ?? values.materialId,
              status: createStatus,
            })) as Row
            const bomId = String(created.id)
            const lineErrors = [
              ...(await persistComponents(bomId, components, [])),
              ...(await persistRoutes(bomId, routes, [])),
              ...(await persistByproducts(bomId, byproducts, [])),
            ]
            if (lineErrors.length > 0) {
              toast.danger('BOM 已创建,但部分明细行保存失败', {
                description: lineErrors.join('; '),
              })
            } else {
              toast.success(
                createStatus === 'ACTIVE'
                  ? 'BOM 已创建并启用'
                  : 'BOM 已创建',
              )
            }
            opts?.onCreated?.(created)
            // 抽屉由 onOpenChange(false) 关;此处只清本地 options,避免双写 URL
            setOptions(undefined)
          } else {
            const bomId = rowId
            if (!bomId) throw new Error('缺少 BOM id,无法更新')
            await bomClient.update(bomId, values)
            const lineErrors = [
              ...(await persistComponents(
                bomId,
                components,
                componentsSnapshot,
              )),
              ...(await persistRoutes(bomId, routes, routesSnapshot)),
              ...(await persistByproducts(
                bomId,
                byproducts,
                byproductsSnapshot,
              )),
            ]
            if (lineErrors.length > 0) {
              toast.danger('BOM 已更新,但部分明细行保存失败', {
                description: lineErrors.join('; '),
              })
            } else {
              toast.success(`${resourceLabel('mfgBoms')} 已更新`)
            }
          }
          await resourceBindingFor('mfgBoms').cache.invalidateAll(queryClient)
        }}
      />

      <Modal.Backdrop
        isOpen={templatePickerOpen}
        onOpenChange={setTemplatePickerOpen}
      >
        <Modal.Container>
          <Modal.Dialog className="max-w-md">
            <Modal.Header>
              <Modal.Heading>从模板带入工艺路线</Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              <RemoteSelect
                resource="mfgProcessTemplates"
                label="工艺模板"
                placeholder="选择工艺模板…"
                searchFields={['name', 'code']}
                value={templateId}
                onChange={(id) => setTemplateId(id)}
              />
              <p className="mt-2 text-xs text-muted">
                按模板步骤整路线复制为本 BOM 的工艺路线,带入后再改模板不影响本
                BOM。
              </p>
            </Modal.Body>
            <Modal.Footer>
              <Button
                variant="secondary"
                onPress={() => setTemplatePickerOpen(false)}
              >
                取消
              </Button>
              <Button
                isDisabled={templateId == null}
                isPending={applying}
                onPress={() => void applyRouteTemplate()}
              >
                带入
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </BomDrawerOpenProvider>
  )
}
