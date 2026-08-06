/**
 * 订单条目 Meta 契约：图纸快照宿主声明（attachments → 附件宿主白名单派生）。
 */
import { describe, expect, test } from 'bun:test'
import { buildOwnerRegistryFromMeta } from '~/platform/files/owner-registry.ts'
import { createSealedResourceRegistry } from '~/platform/meta/register-all.ts'
import { orderItemMeta, orderSpec } from './spec.ts'

describe('订单条目 Meta（图纸快照宿主）', () => {
  test('销/采条目声明 attachments，ownerType 默认表名', () => {
    for (const side of ['sales', 'purchase'] as const) {
      const meta = orderItemMeta(side)
      const spec = orderSpec(side)
      expect(meta.attachments).toEqual({})
      expect(meta.table).toBe(spec.itemTable)
      expect(meta.table).toBe(spec.itemOwnerType)
    }
  })

  test('全量 Registry 派生宿主白名单含 sal_order_item / pur_order_item', () => {
    const owners = buildOwnerRegistryFromMeta(createSealedResourceRegistry().list())
    expect(owners.lookup('sal_order_item')).toEqual({
      resource: 'salOrderItems',
      table: 'sal_order_item',
    })
    expect(owners.lookup('pur_order_item')).toEqual({
      resource: 'purOrderItems',
      table: 'pur_order_item',
    })
    expect(owners.lookup('sal_delivery_item')).toEqual({
      resource: 'salDeliveryItems',
      table: 'sal_delivery_item',
    })
    expect(owners.lookup('pur_receipt_item')).toEqual({
      resource: 'purReceiptItems',
      table: 'pur_receipt_item',
    })
  })
})
