/**
 * 生产设置（mfg_setting）：生产入库超入比例。
 */
import { Decimal, decimal, isDecimalString, toDecimalString } from '@synie/shared'
import type { Kysely } from 'kysely'
import type { DB as Database } from '~/db/types.ts'
import type { Registry } from '~/platform/meta/registry.ts'
import type { ResourceMeta } from '~/platform/meta/types.ts'
import { ApiError } from '~/platform/http/errors.ts'
import { createSingleRowSetting } from '~/platform/settings/single-row.ts'

export const MFG_RESOURCE_NAME = 'mfgSettings'

export interface ManufacturingSetting {
  id: string
  outputOverreceiveRatio: string
  moldCategoryId: string | null
  insertedAt: Date
  updatedAt: Date
}

export interface ManufacturingUpdate {
  outputOverreceiveRatio?: string
  /** undefined=不动；null=清除配置 */
  moldCategoryId?: string | null
}

const MFG_AUDIT = ['output_overreceive_ratio', 'mold_category_id'] as const

export function manufacturingSettingResourceMeta(): ResourceMeta {
  return {
    name: MFG_RESOURCE_NAME,
    permissionPrefix: 'mfg.setting',
    permissionLabel: '生产设置',
    table: 'mfg_setting',
    fields: [
      {
        name: 'id',
        apiName: 'id',
        dbColumn: 'id',
        type: 'uuid',
        label: 'id',
        sortable: true,
        filterable: false,
      },
      {
        name: 'output_overreceive_ratio',
        apiName: 'outputOverreceiveRatio',
        dbColumn: 'output_overreceive_ratio',
        type: 'decimal',
        label: '生产入库超入比例(小数,0=禁超入,0.05=5%,上限 1)',
        sortable: true,
        filterable: true,
      },
      {
        name: 'mold_category_id',
        apiName: 'moldCategoryId',
        dbColumn: 'mold_category_id',
        type: 'fk',
        label: '模具物料分类',
        sortable: false,
        filterable: false,
        ref: { resource: 'invMaterialCategories', relation: 'moldCategory', labelField: 'name' },
      },
      {
        name: 'inserted_at',
        apiName: 'insertedAt',
        dbColumn: 'inserted_at',
        type: 'datetime',
        label: '创建时间',
        sortable: true,
        filterable: true,
      },
      {
        name: 'updated_at',
        apiName: 'updatedAt',
        dbColumn: 'updated_at',
        type: 'datetime',
        label: '更新时间',
        sortable: true,
        filterable: true,
      },
    ],
    print: true,
    audit: { enabled: true },
    actions: [
      { key: 'read', label: '查看', scope: 'both' },
      { key: 'update', label: '编辑', scope: 'row' },
    ],
    form: { exclude: ['id', 'insertedAt', 'updatedAt'] },
  }
}

export function registerManufacturingSettingResources(registry: Registry): void {
  registry.register(manufacturingSettingResourceMeta())
}

export function createManufacturingSettingService(db: Kysely<Database>) {
  const inner = createSingleRowSetting<ManufacturingSetting, ManufacturingUpdate>(db, {
    table: 'mfg_setting',
    resource: 'mfg_setting',
    notFoundMessage: '生产设置不存在',
    permissionPrefix: 'mfg.setting',
    mapRow: mapMfg,
    auditFields: MFG_AUDIT,
    merge(before, input) {
      const after: ManufacturingSetting = {
        ...before,
        outputOverreceiveRatio: input.outputOverreceiveRatio ?? before.outputOverreceiveRatio,
        moldCategoryId:
          input.moldCategoryId === undefined ? before.moldCategoryId : input.moldCategoryId,
      }
      validateRatio('outputOverreceiveRatio', '生产入库超入比例', after.outputOverreceiveRatio)
      return {
        after,
        set: {
          output_overreceive_ratio: after.outputOverreceiveRatio,
          mold_category_id: after.moldCategoryId,
        },
        beforeSnap: {
          output_overreceive_ratio: before.outputOverreceiveRatio,
          mold_category_id: before.moldCategoryId,
        },
        afterSnap: {
          output_overreceive_ratio: after.outputOverreceiveRatio,
          mold_category_id: after.moldCategoryId,
        },
      }
    },
  })
  return {
    getManufacturing: (actor: Parameters<typeof inner.get>[0]) => inner.get(actor),
    updateManufacturing: (
      actor: Parameters<typeof inner.update>[0],
      input: ManufacturingUpdate,
    ) => inner.update(actor, input),
  }
}

export type ManufacturingSettingService = ReturnType<typeof createManufacturingSettingService>

function validateRatio(fieldName: string, label: string, value: string): void {
  if (!isDecimalString(value)) {
    throw ApiError.validation('小数格式不合法', { [fieldName]: ['必须是十进制字符串'] })
  }
  const d = decimal(value)
  if (d.isNegative() || d.greaterThan(1)) {
    throw ApiError.validation(`${label}须在 0 到 1 之间`, { [fieldName]: ['须在 0 到 1 之间'] })
  }
}

function mapMfg(row: Record<string, unknown>): ManufacturingSetting {
  return {
    id: String(row.id),
    outputOverreceiveRatio: toDecimalString(decimal(row.output_overreceive_ratio as string | number | Decimal)),
    moldCategoryId: row.mold_category_id == null ? null : String(row.mold_category_id),
    insertedAt: asDate(row.inserted_at as Date | string),
    updatedAt: asDate(row.updated_at as Date | string),
  }
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value)
}
