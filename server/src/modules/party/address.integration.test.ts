import { afterAll, describe, expect, test } from 'bun:test'
import { createDb } from '~/db/index.ts'
import type { Actor } from '~/platform/authz/actor.ts'
import { createPartyAddressService } from './address-service.ts'
import { createCustomerService } from './party-service.ts'

const url = process.env.SYNIE_TEST_DATABASE_URL
const run = url ? describe : describe.skip

run('PG 集成（对手地址）', () => {
  const db = createDb(url!)
  const addresses = createPartyAddressService(db)
  const customers = createCustomerService(db)
  const actor: Actor = {
    userId: crypto.randomUUID(),
    username: 'address-test',
    name: null,
    superAdmin: true,
    allCompanies: true,
    permissions: new Set(),
    companyIds: [],
  }
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 8)
  const customerIds: string[] = []
  const addressIds: string[] = []

  afterAll(async () => {
    for (const id of addressIds) {
      await db
        .deleteFrom('sys_audit_log')
        .where('resource', '=', 'bas_party_address')
        .where('record_id', '=', id)
        .execute()
      await db.deleteFrom('bas_party_address').where('id', '=', id).execute()
    }
    for (const id of customerIds) {
      await db
        .deleteFrom('sys_audit_log')
        .where('resource', '=', 'sal_customer')
        .where('record_id', '=', id)
        .execute()
      await db.deleteFrom('bas_party_address').where('party_id', '=', id).execute()
      await db.deleteFrom('sal_customers').where('id', '=', id).execute()
    }
    await db.destroy()
  })

  test('CRUD + 默认地址顶替 + 主体校验 + 级联删', async () => {
    const customer = await customers.create(actor, {
      code: `CA${suffix}`,
      name: `地址客户-${suffix}`,
    })
    customerIds.push(customer.id)

    const a1 = await addresses.create(actor, {
      partyType: 'CUSTOMER',
      partyId: customer.id,
      name: '默认收货',
      purpose: 'SHIPPING',
      province: '上海市',
      city: '市辖区',
      district: '浦东新区',
      address: '张江路 1 号',
      isDefault: true,
      contactName: '张三',
      contactPhone: '13800000000',
    })
    addressIds.push(a1.id)
    expect(a1.isDefault).toBe(true)
    expect(a1.purpose).toBe('SHIPPING')
    expect(a1.province).toBe('上海市')
    expect(a1.district).toBe('浦东新区')

    const a2 = await addresses.create(actor, {
      partyType: 'CUSTOMER',
      partyId: customer.id,
      name: '新默认收货',
      purpose: 'SHIPPING',
      province: '江苏省',
      city: '苏州市',
      district: '工业园区',
      address: '星湖街 2 号',
      isDefault: true,
    })
    addressIds.push(a2.id)
    expect(a2.isDefault).toBe(true)

    const reloaded1 = await addresses.get(actor, a1.id)
    expect(reloaded1.isDefault).toBe(false)

    const office = await addresses.create(actor, {
      partyType: 'CUSTOMER',
      partyId: customer.id,
      name: '总部办公',
      purpose: 'OFFICE',
      province: '上海市',
      city: '市辖区',
      district: '黄浦区',
      address: '人民路 3 号',
      isDefault: true,
    })
    addressIds.push(office.id)
    // 不同用途互不影响
    const stillDefault = await addresses.get(actor, a2.id)
    expect(stillDefault.isDefault).toBe(true)

    await expect(
      addresses.create(actor, {
        partyType: 'CUSTOMER',
        partyId: crypto.randomUUID(),
        name: '幽灵',
        purpose: 'OTHER',
        province: '上海市',
        city: '市辖区',
        district: '黄浦区',
        address: 'nowhere',
      }),
    ).rejects.toMatchObject({ code: 'validation' })

    const listed = await addresses.list(actor, {
      limit: 50,
      offset: 0,
      filter: {
        partyType: { kind: 'enum', values: ['CUSTOMER'] },
        partyId: { kind: 'fk', values: [customer.id], labels: [customer.id] },
      },
    })
    expect(listed.count).toBe(3)

    await customers.remove(actor, customer.id)
    customerIds.splice(customerIds.indexOf(customer.id), 1)
    addressIds.length = 0

    const orphan = await db
      .selectFrom('bas_party_address')
      .select('id')
      .where('party_id', '=', customer.id)
      .execute()
    expect(orphan).toHaveLength(0)
  })
})
