/**
 * 财务设置（acc_setting）：OCR 密钥等。
 */
import type { Kysely } from 'kysely'
import type { DB as Database } from '~/db/types.ts'
import type { Registry } from '~/platform/meta/registry.ts'
import type { ResourceMeta } from '~/platform/meta/types.ts'
import { ApiError } from '~/platform/http/errors.ts'
import { createSingleRowSetting } from '~/platform/settings/single-row.ts'
import { auditSpecOf } from '~/platform/audit/spec.ts'
import { sql } from 'kysely'

export const ACC_RESOURCE_NAME = 'accSettings'

export interface AccountingSetting {
  id: string
  ocrAccessKeyId: string | null
  insertedAt: Date
  updatedAt: Date
}

export interface AccountingUpdate {
  ocrAccessKeyId?: string | null
  ocrAccessKeyIdPresent?: boolean
  ocrAccessKeySecret?: string
}

const ACC_AUDIT_SPEC = auditSpecOf(accountingSettingResourceMeta())

export function accountingSettingResourceMeta(): ResourceMeta {
  const meta: ResourceMeta = {
    name: ACC_RESOURCE_NAME,
    permissionPrefix: 'acc.setting',
    permissionLabel: '财务设置',
    table: 'acc_setting',
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
        name: 'ocr_access_key_id',
        apiName: 'ocrAccessKeyId',
        dbColumn: 'ocr_access_key_id',
        type: 'string',
        label: '阿里云 OCR AccessKey ID',
        sortable: true,
        filterable: true,
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
    // extra：OCR 密钥为写专列（不进 Grid/Form 字段），仍要审计（sensitiveFields 脱敏）
    audit: {
      enabled: true,
      sensitiveFields: ['ocr_access_key_secret'],
      extra: ['ocr_access_key_secret'],
    },
    actions: [
      { key: 'read', label: '查看', scope: 'both' },
      { key: 'update', label: '编辑', scope: 'row' },
    ],
    form: { exclude: ['id', 'insertedAt', 'updatedAt'] },
  }
  return meta
}

export function registerFinanceSettingResources(registry: Registry): void {
  registry.register(accountingSettingResourceMeta())
}

export function createAccountingSettingService(db: Kysely<Database>) {
  const inner = createSingleRowSetting<AccountingSetting, AccountingUpdate>(db, {
    table: 'acc_setting',
    resource: 'acc_setting',
    notFoundMessage: '财务设置不存在',
    permissionPrefix: 'acc.setting',
    mapRow: mapAcc,
    auditFields: ACC_AUDIT_SPEC.fields,
    sensitiveFields: ACC_AUDIT_SPEC.sensitiveFields,
    merge(before, input, lockedRow) {
      let keyId = before.ocrAccessKeyId
      let secret = (lockedRow.ocr_access_key_secret as string | null) ?? null
      if (input.ocrAccessKeyIdPresent) {
        keyId = input.ocrAccessKeyId ?? null
      }
      if (input.ocrAccessKeySecret !== undefined && input.ocrAccessKeySecret !== '') {
        secret = input.ocrAccessKeySecret
      }
      if (keyId !== null && [...keyId].length > 128) {
        throw ApiError.validation('OCR AccessKey ID 不能超过 128 个字符', {
          ocrAccessKeyId: ['不能超过 128 个字符'],
        })
      }
      if (secret !== null && [...secret].length > 128) {
        throw ApiError.validation('OCR AccessKey Secret 不能超过 128 个字符', {
          ocrAccessKeySecret: ['不能超过 128 个字符'],
        })
      }
      const after: AccountingSetting = { ...before, ocrAccessKeyId: keyId }
      return {
        after,
        set: {
          ocr_access_key_id: keyId,
          ocr_access_key_secret: secret,
        },
        beforeSnap: {
          ocr_access_key_id: before.ocrAccessKeyId,
          ocr_access_key_secret: lockedRow.ocr_access_key_secret ?? null,
        },
        afterSnap: {
          ocr_access_key_id: keyId,
          ocr_access_key_secret: secret,
        },
      }
    },
  })

  async function ocrConfigured(): Promise<boolean> {
    const result = await sql<{ id: string | null; secret: string | null }>`
      SELECT ocr_access_key_id AS id, ocr_access_key_secret AS secret
      FROM acc_setting LIMIT 1
    `.execute(db)
    const row = result.rows[0]
    if (!row) return false
    return !!(row.id?.trim() && row.secret?.trim())
  }

  return {
    getAccounting: (actor: Parameters<typeof inner.get>[0]) => inner.get(actor),
    updateAccounting: (actor: Parameters<typeof inner.update>[0], input: AccountingUpdate) =>
      inner.update(actor, input),
    ocrConfigured,
  }
}

export type AccountingSettingService = ReturnType<typeof createAccountingSettingService>

function mapAcc(row: Record<string, unknown>): AccountingSetting {
  return {
    id: String(row.id),
    ocrAccessKeyId: (row.ocr_access_key_id as string | null) ?? null,
    insertedAt: asDate(row.inserted_at as Date | string),
    updatedAt: asDate(row.updated_at as Date | string),
  }
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value)
}
