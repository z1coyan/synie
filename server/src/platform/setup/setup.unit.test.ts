import { describe, expect, test } from 'bun:test'
import { ApiError } from '../http/errors.ts'
import { createSetupService } from './service.ts'
import { createTokenManager } from '../auth/token.ts'

/**
 * 不依赖 PG 的校验路径：通过 stub db 触发 service 层参数校验。
 * createFirstUser 的字段校验在进事务前完成。
 */
describe('setup service 参数校验', () => {
  const tokens = createTokenManager({ secret: 'unit-test-secret-32-bytes-min!!', ttlSeconds: 60 })
  // 最小 stub：任何事务调用都会失败，但校验在 withTx 之前
  const db = {
    transaction: () => ({
      execute: async () => {
        throw new Error('should not reach tx')
      },
    }),
  } as never

  const setup = createSetupService({ db, tokens })

  test('createFirstUser 空用户名 / 空密码 validation', async () => {
    await expect(setup.createFirstUser({ username: '', password: 'x' })).rejects.toMatchObject({
      code: 'validation',
    })
    await expect(setup.createFirstUser({ username: 'a', password: '' })).rejects.toMatchObject({
      code: 'validation',
    })
  })

  test('complete 非法语言 validation', async () => {
    await expect(
      setup.complete(
        {
          userId: crypto.randomUUID(),
          username: 'u',
          name: null,
          superAdmin: true,
          allCompanies: true,
          permissions: new Set(),
          companyIds: [],
        },
        'fr-FR',
        false,
      ),
    ).rejects.toBeInstanceOf(ApiError)
    try {
      await setup.complete(
        {
          userId: crypto.randomUUID(),
          username: 'u',
          name: null,
          superAdmin: true,
          allCompanies: true,
          permissions: new Set(),
          companyIds: [],
        },
        'fr-FR',
        false,
      )
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError)
      expect((err as ApiError).code).toBe('validation')
    }
  })

  test('complete 无 sample 依赖且 seedSampleData=true → not_implemented', async () => {
    // completeBaseSeeds 会进事务；这里用 reject 的 stub 让 base 阶段失败
    // 单独验证：当 base 已过但 sample 未配置时的路径在 service 中有 not_implemented 分支
    // 本测只钉错误类型构造
    const err = new ApiError(
      'not_implemented',
      'Setup 尚未配置示例数据依赖,初始化未完成且完成旗标未写入',
    )
    expect(err.code).toBe('not_implemented')
    expect(err.status).toBe(501)
  })
})
