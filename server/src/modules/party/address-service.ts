/**
 * 客商/公司从属地址（多态主体，无公司列 → global 形态）。
 *
 * 授权全由平台承担：路由挂 `guard(资源, 动作)`，本服务只收 Permit。
 * 默认地址唯一、主体存在性是领域不变量，留在本文件。
 */
import type { ListQuery } from '@synie/shared'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import { withTx, type TrxHandle } from '~/db/tx.ts'
import type { DB as Database } from '~/db/types.ts'
import { mapWriteError } from '~/db/dberr.ts'
import { listAuthorized } from '~/db/list.ts'
import { loadAuthorized } from '~/db/load.ts'
import {
  auditCreated,
  auditDestroyed,
  auditDiff,
  writeAudit,
} from '~/platform/audit/write.ts'
import { auditFieldsOf } from '~/platform/audit/spec.ts'
import type { Permit } from '~/platform/authz/core/index.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { Registry } from '~/platform/meta/registry.ts'
import { PARTY_ADDRESS_RESOURCE_NAME, partyAddressResourceMeta } from './meta.ts'

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
}

const PARTY_TYPES = new Set<string>(['CUSTOMER', 'SUPPLIER', 'COMPANY'])
const PURPOSES = new Set<string>(['SHIPPING', 'OFFICE', 'OTHER'])
const AUDIT = auditFieldsOf(partyAddressResourceMeta())
const AUDIT_RESOURCE = 'bas_party_address'
const META = partyAddressResourceMeta()
const TABLE = META.table

/** wire 大写 → 库内小写 */
function toDbEnum(value: string): string {
  return value.trim().toLowerCase()
}

/** 库内小写 → wire 大写 */
function toWireEnum(value: string): string {
  return value.trim().toUpperCase()
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

export function createPartyAddressService(db: Kysely<Database>, registry: Registry) {
  const target = registry.authzTarget(PARTY_ADDRESS_RESOURCE_NAME)

  async function get(permit: Permit, id: string): Promise<PartyAddress> {
    const row = await loadAuthorized({
      db,
      permit,
      target,
      table: TABLE,
      id,
      notFoundMessage: '地址不存在',
    })
    return mapRow(row as never)
  }

  async function list(permit: Permit, query: Partial<ListQuery>) {
    return listAuthorized({
      db,
      permit,
      target,
      alias: TABLE,
      resource: META,
      source: sql` FROM bas_party_address`,
      select: sql`SELECT id, party_type, party_id, name, purpose, contact_name, contact_phone,
        province, city, district, address, is_default, active, remarks, inserted_at, updated_at`,
      defaultOrder: sql`"is_default" DESC, "name" ASC, "id" ASC`,
      query,
      mapRow: (r) =>
        mapRow({
          id: String(r.id),
          party_type: String(r.party_type),
          party_id: String(r.party_id),
          name: String(r.name),
          purpose: String(r.purpose),
          contact_name: r.contact_name == null ? null : String(r.contact_name),
          contact_phone: r.contact_phone == null ? null : String(r.contact_phone),
          province: String(r.province ?? ''),
          city: String(r.city ?? ''),
          district: String(r.district ?? ''),
          address: String(r.address),
          is_default: Boolean(r.is_default),
          active: Boolean(r.active),
          remarks: r.remarks == null ? null : String(r.remarks),
          inserted_at: r.inserted_at as Date,
          updated_at: r.updated_at as Date,
        }),
    })
  }

  async function create(
    permit: Permit,
    input: {
      partyType: string
      partyId: string
      name: string
      purpose: string
      contactName?: string | null
      contactPhone?: string | null
      province: string
      city: string
      district: string
      address: string
      isDefault?: boolean
      active?: boolean
      remarks?: string | null
    },
  ): Promise<PartyAddress> {
    const partyType = parsePartyType(input.partyType)
    const purpose = parsePurpose(input.purpose)
    const name = requireText(input.name, 'name', '地址名称')
    const province = requireText(input.province, 'province', '省/直辖市')
    const city = requireText(input.city, 'city', '市')
    const district = requireText(input.district, 'district', '区/县')
    const address = requireText(input.address, 'address', '街道门牌')
    const contactName = emptyToNull(input.contactName)
    const contactPhone = emptyToNull(input.contactPhone)
    const remarks = emptyToNull(input.remarks)
    const isDefault = input.isDefault ?? false
    const active = input.active ?? true

    return withTx(db, async (trx) => {
      await assertPartyExists(trx, partyType, input.partyId)
      if (isDefault) {
        await clearDefault(trx, partyType, input.partyId, purpose)
      }
      try {
        const row = await trx
          .insertInto('bas_party_address')
          .values({
            party_type: toDbEnum(partyType),
            party_id: input.partyId,
            name,
            purpose: toDbEnum(purpose),
            contact_name: contactName,
            contact_phone: contactPhone,
            province,
            city,
            district,
            address,
            is_default: isDefault,
            active,
            remarks,
          })
          .returningAll()
          .executeTakeFirstOrThrow()
        const item = mapRow(row)
        await writeAudit(trx, permit.actor, {
          resource: AUDIT_RESOURCE,
          recordId: item.id,
          recordLabel: item.name,
          actionType: 'create',
          actionName: 'create',
          changes: auditCreated(snap(item), AUDIT),
        })
        return item
      } catch (err) {
        throw mapWriteError(err, '创建地址失败', [
          { code: '23505', message: '同主体同用途已有默认地址' },
        ])
      }
    })
  }

  async function update(
    permit: Permit,
    id: string,
    input: {
      name?: string
      purpose?: string
      contactName?: string | null
      contactNamePresent?: boolean
      contactPhone?: string | null
      contactPhonePresent?: boolean
      province?: string
      city?: string
      district?: string
      address?: string
      isDefault?: boolean
      active?: boolean
      remarks?: string | null
      remarksPresent?: boolean
    },
  ): Promise<PartyAddress> {
    return withTx(db, async (trx) => {
      const locked = await loadAuthorized({
        db: trx,
        permit,
        target,
        table: TABLE,
        id,
        forUpdate: true,
        notFoundMessage: '地址不存在',
      })
      const before = mapRow(locked as never)

      const name =
        input.name !== undefined ? requireText(input.name, 'name', '地址名称') : before.name
      const purpose =
        input.purpose !== undefined ? parsePurpose(input.purpose) : before.purpose
      const province =
        input.province !== undefined
          ? requireText(input.province, 'province', '省/直辖市')
          : before.province
      const city =
        input.city !== undefined ? requireText(input.city, 'city', '市') : before.city
      const district =
        input.district !== undefined
          ? requireText(input.district, 'district', '区/县')
          : before.district
      const address =
        input.address !== undefined
          ? requireText(input.address, 'address', '街道门牌')
          : before.address
      const contactName = input.contactNamePresent
        ? emptyToNull(input.contactName)
        : before.contactName
      const contactPhone = input.contactPhonePresent
        ? emptyToNull(input.contactPhone)
        : before.contactPhone
      const remarks = input.remarksPresent ? emptyToNull(input.remarks) : before.remarks
      const isDefault = input.isDefault ?? before.isDefault
      const active = input.active ?? before.active

      const after: PartyAddress = {
        ...before,
        name,
        purpose,
        province,
        city,
        district,
        address,
        contactName,
        contactPhone,
        remarks,
        isDefault,
        active,
      }
      const changes = auditDiff(snap(before), snap(after), AUDIT)
      if (Object.keys(changes).length === 0) return before

      if (isDefault && (!before.isDefault || purpose !== before.purpose)) {
        await clearDefault(trx, before.partyType, before.partyId, purpose, id)
      }

      try {
        const row = await trx
          .updateTable('bas_party_address')
          .set({
            name,
            purpose: toDbEnum(purpose),
            contact_name: contactName,
            contact_phone: contactPhone,
            province,
            city,
            district,
            address,
            is_default: isDefault,
            active,
            remarks,
            updated_at: sql`(now() AT TIME ZONE 'utc')`,
          })
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirstOrThrow()
        const item = mapRow(row)
        await writeAudit(trx, permit.actor, {
          resource: AUDIT_RESOURCE,
          recordId: item.id,
          recordLabel: item.name,
          actionType: 'update',
          actionName: 'update',
          changes,
        })
        return item
      } catch (err) {
        throw mapWriteError(err, '更新地址失败', [
          { code: '23505', message: '同主体同用途已有默认地址' },
        ])
      }
    })
  }

  async function remove(permit: Permit, id: string): Promise<void> {
    await withTx(db, async (trx) => {
      const locked = await loadAuthorized({
        db: trx,
        permit,
        target,
        table: TABLE,
        id,
        forUpdate: true,
        notFoundMessage: '地址不存在',
      })
      const item = mapRow(locked as never)
      await trx.deleteFrom('bas_party_address').where('id', '=', id).execute()
      await writeAudit(trx, permit.actor, {
        resource: AUDIT_RESOURCE,
        recordId: item.id,
        recordLabel: item.name,
        actionType: 'destroy',
        actionName: 'destroy',
        changes: auditDestroyed(snap(item), AUDIT),
      })
    })
  }

  return { get, list, create, update, remove }
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

function parsePartyType(v: string): PartyAddressPartyType {
  if (!PARTY_TYPES.has(v)) {
    throw new ApiError('validation', '主体类型无效', {
      fields: { partyType: ['须为 CUSTOMER / SUPPLIER / COMPANY'] },
    })
  }
  return v as PartyAddressPartyType
}

function parsePurpose(v: string): PartyAddressPurpose {
  if (!PURPOSES.has(v)) {
    throw new ApiError('validation', '地址用途无效', {
      fields: { purpose: ['须为 SHIPPING / OFFICE / OTHER'] },
    })
  }
  return v as PartyAddressPurpose
}

function requireText(v: string, field: string, label: string): string {
  const t = v.trim()
  if (!t) {
    throw new ApiError('validation', `${label}不能为空`, {
      fields: { [field]: [`${label}不能为空`] },
    })
  }
  return t
}

function emptyToNull(v: string | null | undefined): string | null {
  if (v == null) return null
  const t = v.trim()
  return t === '' ? null : t
}

function mapRow(row: {
  id: string
  party_type: string
  party_id: string
  name: string
  purpose: string
  contact_name: string | null
  contact_phone: string | null
  province: string
  city: string
  district: string
  address: string
  is_default: boolean
  active: boolean
  remarks: string | null
  inserted_at: Date
  updated_at: Date
}): PartyAddress {
  return {
    id: row.id,
    partyType: toWireEnum(row.party_type) as PartyAddressPartyType,
    partyId: row.party_id,
    name: row.name,
    purpose: toWireEnum(row.purpose) as PartyAddressPurpose,
    contactName: row.contact_name,
    contactPhone: row.contact_phone,
    province: row.province,
    city: row.city,
    district: row.district,
    address: row.address,
    isDefault: row.is_default,
    active: row.active,
    remarks: row.remarks,
    insertedAt: row.inserted_at,
    updatedAt: row.updated_at,
  }
}

function snap(item: PartyAddress): Record<(typeof AUDIT)[number], unknown> {
  return {
    party_type: item.partyType,
    party_id: item.partyId,
    name: item.name,
    purpose: item.purpose,
    contact_name: item.contactName,
    contact_phone: item.contactPhone,
    province: item.province,
    city: item.city,
    district: item.district,
    address: item.address,
    is_default: item.isDefault,
    active: item.active,
    remarks: item.remarks,
  }
}
