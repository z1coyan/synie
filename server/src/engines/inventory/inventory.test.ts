import { describe, expect, test } from 'bun:test'
import { ApiError } from '~/platform/http/errors.ts'
import { post } from './engine.ts'
import type { StockVoucher } from './types.ts'

/** 无 DB 即可验证的凭证/行形状：用 mock 会过重，这里只测会在触库前抛出的校验 */
describe('inventory 形状校验（触库前）', () => {
  // post 在空 lines 时不访问 db 的查询路径——但 validateVoucher 之后立即检查 lines。
  // 传入 null-ish db 会在更早的行校验失败。

  test('空分录拒绝', async () => {
    const voucher: StockVoucher = {
      type: 'inv.stock_doc',
      id: crypto.randomUUID(),
      no: 'DOC-1',
      companyId: crypto.randomUUID(),
      postingDate: '2026-07-26',
    }
    // db 不会被用到（lines 空即抛）
    await expect(post(null as never, voucher, [])).rejects.toMatchObject({
      code: 'validation',
      message: '库存过账校验失败',
    })
  })

  test('凭证缺参拒绝', async () => {
    try {
      await post(null as never, {
        type: '',
        id: '',
        no: '',
        companyId: '',
        postingDate: '',
      }, [{ warehouseId: 'a', materialId: 'b', quantity: '1' }])
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError)
      const e = err as ApiError
      expect(e.message).toBe('库存过账参数不合法')
      expect(e.fields).toHaveProperty('voucherType')
      expect(e.fields).toHaveProperty('voucherId')
      expect(e.fields).toHaveProperty('voucherNo')
      expect(e.fields).toHaveProperty('companyId')
      expect(e.fields).toHaveProperty('postingDate')
    }
  })

  test('数量为零拒绝（触库前）', async () => {
    try {
      await post(
        null as never,
        {
          type: 'inv.stock_doc',
          id: crypto.randomUUID(),
          no: 'DOC-Z',
          companyId: crypto.randomUUID(),
          postingDate: '2026-07-26',
        },
        [{ warehouseId: crypto.randomUUID(), materialId: crypto.randomUUID(), quantity: '0' }],
      )
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError)
      expect((err as ApiError).fields?.['lines.0.quantity']?.[0]).toBe('数量不能为零')
    }
  })
})
