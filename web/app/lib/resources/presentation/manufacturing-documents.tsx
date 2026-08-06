/**
 * 制造域 Presentation Extension。
 *
 * 生产入库的 document preview 与 Drawer 共置；需求、工单与生产入库的审核
 * 配置继续由各自业务 drawer module 导出。
 */
import { RemoteSelect } from '~/components/synie-remote-select/RemoteSelect'
import type { FieldInputProps } from '~/components/synie-record-drawer/fields'
import type { ResourceBinding } from '../catalog/types'
import {
  AUDIT_TRAIL_EXCLUDE,
  LINE_REMARK_OVERRIDE,
  materialCodeOverride,
  previewHead,
  UNIT_ID_SNAPSHOT_OVERRIDE,
} from './document-preview-helpers'
import {
  presentationFromDefinitions,
  type PresentationDefinition,
} from './group'
import type { PresentationExtension } from './types'

export const MANUFACTURING_DOCUMENT_RESOURCES = [
  'mfgProcessTemplates',
  'mfgBoms',
  'mfgDemands',
  'mfgWorkOrders',
  'mfgOutputs',
] as const

export type ManufacturingDocumentResource =
  (typeof MANUFACTURING_DOCUMENT_RESOURCES)[number]

/**
 * 下发车间输入：候选按**本表单已选公司**收窄且只取启用中的部门，与后端同公司硬校验同口径。
 * 指派列不受操作者部门约束（计划员可下发任意车间），故不按 me.deptId 过滤。
 * 指派类型=生产才可选（其余类型禁用并由 assignType 联动清空），与 service 联动校验同口径。
 */
function AssignedDeptInput({ value, onChange, isDisabled, values }: FieldInputProps) {
  const companyId = values.companyId == null || values.companyId === '' ? null : String(values.companyId)
  const isMake = values.assignType === 'MAKE'
  return (
    <RemoteSelect
      resource="sysDepartments"
      label="下发车间"
      labelField="name"
      placeholder={
        !isMake ? '仅指派类型为生产时可填' : companyId ? '选择本公司车间…' : '先选公司'
      }
      value={value == null || value === '' ? null : String(value)}
      onChange={(id) => onChange(id)}
      isDisabled={isDisabled || companyId == null || !isMake}
      filterState={
        companyId
          ? {
              companyId: { kind: 'fk', op: 'in', values: [companyId], labels: [] },
              enabled: { kind: 'bool', eq: true },
            }
          : undefined
      }
    />
  )
}

const DEFINITIONS = {
  mfgProcessTemplates: {
    label: '工艺模板',
    contentClassName: 'w-full lg:w-[760px]',
    tabs: [
      { key: 'basic', label: '基本信息' },
      { key: 'items', label: '工艺步骤' },
    ],
    fields: {
      code: {
        order: 0,
        cols: 6,
        edit: 'createOnly',
        placeholder: '留空自动编号',
      },
      name: {
        order: 1,
        cols: 6,
        required: true,
        placeholder: '如 冲网标准工艺',
      },
      note: { order: 2 },
      insertedAt: { order: 98, section: '' },
      updatedAt: { order: 99 },
    },
  },
  mfgBoms: {
    label: 'BOM',
    contentClassName: 'w-full lg:w-[880px]',
    tabs: [
      { key: 'basic', label: '基本信息' },
      { key: 'components', label: '配料' },
      { key: 'routes', label: '工艺路线' },
      { key: 'byproducts', label: '副产品' },
    ],
    fields: {
      code: {
        order: 0,
        cols: 6,
        edit: 'createOnly',
        placeholder: '留空自动编号',
      },
      planName: {
        order: 1,
        cols: 6,
        placeholder: '如 自用 / 委外',
      },
      materialId: {
        order: 2,
        required: true,
        edit: 'createOnly',
        picker: 'dialog',
      },
      note: { order: 3 },
      insertedAt: { order: 98, section: '' },
      updatedAt: { order: 99 },
    },
  },
  mfgDemands: {
    label: '履约需求单',
    contentClassName: 'w-full lg:w-[960px]',
    exclude: ['status', 'createdById', 'insertedAt', 'updatedAt'],
    fields: {
      companyId: {
        required: true,
        order: -1,
        cols: 6,
        edit: 'createOnly',
      },
      demandNo: {
        order: 0,
        cols: 6,
        placeholder: '留空自动编号',
      },
      demandDate: { order: 1, cols: 6, required: true },
      // 指派类型：纯路由声明；切离「生产」时联动清空下发车间
      assignType: {
        order: 2,
        cols: 6,
        required: true,
        effects: (value) => (value === 'MAKE' ? {} : { assignedDeptId: null }),
      },
      // 单头需求日：仅作新建行的行需求日默认值；「批量带入」按钮在需求行工具栏
      needDate: { order: 3, cols: 6 },
      // 草稿态可填可改（类型=生产才可选）；确认后改派走行动作 dispatch（本表单确认后整体不可编辑）
      assignedDeptId: {
        order: 4,
        cols: 6,
        label: '下发车间',
        input: (p) => <AssignedDeptInput {...p} />,
      },
      remarks: { order: 5 },
    },
  },
  mfgWorkOrders: {
    label: '生产工单',
    // ownerDeptId 与 createdById 同类：创建时盖章的归属字段不进单据表单，列表列展示
    exclude: [
      'status',
      'createdById',
      'ownerDeptId',
      'insertedAt',
      'updatedAt',
      'baseQty',
      'receivedBaseQty',
      'remainingBaseQty',
    ],
    fields: {
      workOrderNo: {
        order: 0,
        cols: 6,
        placeholder: '留空自动编号',
      },
      demandItemId: {
        order: 1,
        required: true,
        edit: 'createOnly',
        label: '来源需求行',
        picker: 'dialog',
        dialog: {
          dialogTitle: '选择来源需求行',
          dialogClassName: 'max-w-6xl',
          gridColumns: [
            'companyId',
            'demandId',
            'idx',
            'materialCode',
            'materialName',
            'materialSpec',
            'qty',
            'remainingArrangeableQty',
            'unitName',
            'needDate',
            'status',
          ],
          gridExtraFields: ['materialId', 'unitId'],
          gridOverrides: {
            companyId: { mobileRole: 'hide' },
            demandId: {
              label: '需求单',
              mobileRole: 'subtitle',
            },
            idx: { mobileRole: 'hide' },
            materialCode: {
              label: '物料编号',
              mobileRole: 'hide',
            },
            materialName: {
              label: '物料名称',
              mobileRole: 'title',
            },
            materialSpec: {
              label: '规格',
              mobileRole: 'hide',
            },
            qty: { mobileRole: 'summary' },
            remainingArrangeableQty: {
              label: '剩余可安排',
              mobileRole: 'summary',
            },
            unitName: {
              label: '单位',
              mobileRole: 'hide',
            },
            needDate: { mobileRole: 'summary' },
            status: {
              label: '状态',
              mobileRole: 'summary',
            },
          },
          gridDefaultSort: {
            column: 'needDate',
            direction: 'ascending',
          },
        },
        effects: (_value, selectedRow) => ({
          companyId: selectedRow?.companyId ?? null,
          demandId: selectedRow?.demandId ?? null,
          materialId: selectedRow?.materialId ?? null,
          unitId: selectedRow?.unitId ?? null,
          qty:
            selectedRow?.remainingArrangeableQty ??
            selectedRow?.remainingOrderableQty ??
            selectedRow?.qty ??
            null,
          baseQty: selectedRow?.baseQty ?? null,
          needDate: selectedRow?.needDate ?? null,
          materialCode: selectedRow?.materialCode ?? '',
          materialName: selectedRow?.materialName ?? '',
          materialSpec: selectedRow?.materialSpec ?? '',
          unitName: selectedRow?.unitName ?? '',
          bomId: null,
        }),
      },
      companyId: {
        order: 2,
        cols: 6,
        edit: 'readOnly',
        placeholder: '由来源需求行带入',
      },
      demandId: {
        order: 3,
        cols: 6,
        edit: 'readOnly',
        label: '来源需求单',
        placeholder: '由来源需求行带入',
      },
      materialId: {
        order: 4,
        cols: 6,
        edit: 'readOnly',
        placeholder: '由来源需求行带入',
      },
      unitId: {
        order: 5,
        cols: 6,
        edit: 'readOnly',
        placeholder: '由来源需求行带入',
      },
      qty: {
        order: 6,
        cols: 6,
        required: true,
        edit: 'createOnly',
        label: '工单数量',
      },
      needDate: { order: 7, cols: 6, edit: 'readOnly' },
      materialCode: {
        order: 8,
        cols: 6,
        edit: 'readOnly',
      },
      materialName: {
        order: 9,
        cols: 6,
        edit: 'readOnly',
      },
      materialSpec: {
        order: 10,
        cols: 6,
        edit: 'readOnly',
      },
      unitName: {
        order: 11,
        cols: 6,
        edit: 'readOnly',
      },
      bomId: {
        order: 12,
        cols: 12,
        label: 'BOM',
        section: '配方',
        placeholder: '可选；限本物料启用中 BOM',
      },
    },
  },
  mfgOutputs: {
    label: '生产入库单',
    contentClassName: 'w-full lg:w-[960px]',
    exclude: AUDIT_TRAIL_EXCLUDE,
    fields: {
      companyId: {
        required: true,
        order: -1,
        cols: 6,
        edit: 'createOnly',
      },
      outputNo: {
        order: 0,
        cols: 6,
        placeholder: '留空自动编号',
      },
      outputDate: { order: 1, cols: 6, required: true },
      warehouseId: { order: 2, label: '默认仓库' },
      remarks: { order: 3 },
    },
    documentPreview: (presentation) => ({
      label: presentation.label,
      docNoField: 'outputNo',
      head: previewHead(presentation),
      lineTables: [
        {
          title: '入库条目',
          resource: 'mfgOutputItems',
          parentIdField: 'outputId',
          columns: [
            'idx',
            'materialCode',
            'workOrderId',
            'unitId',
            'qty',
            'warehouseId',
            'remarks',
          ],
          exclude: [
            'outputId',
            'companyId',
            'materialId',
            'baseQty',
            'materialName',
            'materialSpec',
            'unitName',
            'outputNo',
            'outputDate',
            'outputStatus',
          ],
          overrides: {
            materialCode: materialCodeOverride({ wide: true }),
            unitId: UNIT_ID_SNAPSHOT_OVERRIDE,
            remarks: LINE_REMARK_OVERRIDE,
          },
        },
      ],
    }),
  },
} satisfies Record<ManufacturingDocumentResource, PresentationDefinition>

export function createManufacturingDocumentPresentation(
  binding: ResourceBinding,
): PresentationExtension {
  return presentationFromDefinitions(binding, DEFINITIONS, '制造资源')
}
