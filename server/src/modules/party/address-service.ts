/**
 * 客商/公司从属地址（多态主体，无公司列 → global 形态）——标准派生服务。
 *
 * CRUD/批量/审计/授权全部由 `platform/standard` 按 meta 派生；本文件只留领域不变量：
 * 主体存在性（多态无 DB 外键）、同主体同用途默认地址唯一（写前顶替）、空串归一。
 */
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import type { TrxHandle } from '~/db/tx.ts'
import type { DB as Database } from '~/db/types.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { Registry } from '~/platform/meta/registry.ts'
import { createStandardService, type StandardService } from '~/platform/standard/service.ts'
import { PARTY_ADDRESS_RESOURCE_NAME } from './meta.ts'

export type PartyAddressPartyType = 'CUSTOMER' | 'SUPPLIER' | 'COMPANY'
export type PartyAddressPurpose = 'SHIPPING' | 'OFFICE' | 'OTHER'

export interface PartyAddress {
  id: string
  partyType: PartyAddressPartyType
  partyId: string
  name: string
  purpose: PartyAddressPurpose
  contactName: string | null
  contactPhone: string | null
  /** 省/直辖市（中文名，前端 PCA 级联） */
  province: string
  /** 市（中文名） */
  city: string
  /** 区/县（中文名） */
  district: string
  /** 街道门牌等明细（不含省市区） */
  address: string
  isDefault: boolean
  active: boolean
  remarks: string | null
  insertedAt: Date
  updatedAt: Date
  [key: string]: unknown
}

/** wire 大写 → 库内小写 */
function toDbEnum(value: string): string {
  return value.trim().toLowerCase()
}

/** 删除主体时级联清地址（多态无 DB 外键） */
export async function deleteAddressesForParty(
  trx: TrxHandle,
  partyType: PartyAddressPartyType,
  partyId: string,
): Promise<void> {
  await trx
    .deleteFrom('bas_party_address')
    .where('party_type', '=', toDbEnum(partyType))
    .where('party_id', '=', partyId)
    .execute()
}

export function createPartyAddressService(
  db: Kysely<Database>,
  registry: Registry,
): StandardService<PartyAddress> {
  return createStandardService<PartyAddress>({
    db,
    registry,
    resource: PARTY_ADDRESS_RESOURCE_NAME,
    notFound: '地址不存在',
    defaultOrder: sql`"is_default" DESC, "name" ASC, "id" ASC`,
    writeErrors: [{ code: '23505', message: '同主体同用途已有默认地址' }],
    hooks: {
      validate: ({ draft }) => {
        for (const key of ['contactName', 'contactPhone', 'remarks']) {
          if (draft[key] === '') draft[key] = null
        }
      },
      beforeWrite: async (trx, { action, draft, before }) => {
        const partyType = String(draft.partyType) as PartyAddressPartyType
        const partyId = String(draft.partyId)
        const purpose = String(draft.purpose) as PartyAddressPurpose
        if (action === 'create') {
          await assertPartyExists(trx, partyType, partyId)
          if (draft.isDefault === true) await clearDefault(trx, partyType, partyId, purpose)
          return
        }
        // 改判默认或换用途：先摘掉同主体同用途的旧默认（部分唯一索引保底）
        if (draft.isDefault === true && before && (!before.isDefault || purpose !== before.purpose)) {
          await clearDefault(trx, partyType, partyId, purpose, String(draft.id))
        }
      },
    },
  })
}

export type PartyAddressService = ReturnType<typeof createPartyAddressService>

async function clearDefault(
  trx: TrxHandle,
  partyType: PartyAddressPartyType,
  partyId: string,
  purpose: PartyAddressPurpose,
  exceptId?: string,
): Promise<void> {
  let q = trx
    .updateTable('bas_party_address')
    .set({
      is_default: false,
      updated_at: sql`(now() AT TIME ZONE 'utc')`,
    })
    .where('party_type', '=', toDbEnum(partyType))
    .where('party_id', '=', partyId)
    .where('purpose', '=', toDbEnum(purpose))
    .where('is_default', '=', true)
  if (exceptId) q = q.where('id', '<>', exceptId)
  await q.execute()
}

async function assertPartyExists(
  trx: TrxHandle,
  partyType: PartyAddressPartyType,
  partyId: string,
): Promise<void> {
  const table =
    partyType === 'CUSTOMER'
      ? 'sal_customers'
      : partyType === 'SUPPLIER'
        ? 'pur_supplier'
        : 'bas_company'
  const row = await trx
    .selectFrom(table)
    .select('id')
    .where('id', '=', partyId)
    .executeTakeFirst()
  if (!row) {
    const label =
      partyType === 'CUSTOMER' ? '客户' : partyType === 'SUPPLIER' ? '供应商' : '公司'
    throw new ApiError('validation', `${label}不存在`, {
      fields: { partyId: [`${label}不存在`] },
    })
  }
}
