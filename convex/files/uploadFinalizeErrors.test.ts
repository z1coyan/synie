import { describe, expect, test } from 'bun:test'
import { synieError } from '../lib/errors'
import {
  deleteRejectedUploadObjects,
  isDeterministicFinalizeRejection,
} from './uploadFinalizeErrors'

describe('上传确认错误分类', () => {
  test('业务拒绝会触发对象清理', () => {
    for (const code of ['validation', 'unauthorized', 'forbidden', 'not_found', 'conflict'] as const) {
      expect(isDeterministicFinalizeRejection(synieError(code, '拒绝'))).toBe(true)
      expect(isDeterministicFinalizeRejection({ data: { code, message: '拒绝' } })).toBe(true)
    }
    expect(isDeterministicFinalizeRejection(
      new Error('Uncaught ConvexError: {"code":"conflict","message":"容量已满"}'),
    )).toBe(true)
  })

  test('瞬态或未知错误保留对象供幂等重试', () => {
    expect(isDeterministicFinalizeRejection(synieError('internal', '响应丢失'))).toBe(false)
    expect(isDeterministicFinalizeRejection(synieError('rate_limited', '稍后重试'))).toBe(false)
    expect(isDeterministicFinalizeRejection(new Error('S3 connection reset'))).toBe(false)
    expect(isDeterministicFinalizeRejection(null)).toBe(false)
  })

  test('只有所有精确 key 删除成功才允许封闭意图', async () => {
    const removed: string[] = []
    expect(await deleteRejectedUploadObjects(['files/a', 'uploads/a', 'files/a'], async (key) => {
      removed.push(key)
    })).toBe(true)
    expect(removed).toEqual(['files/a', 'uploads/a'])

    const attempted: string[] = []
    expect(await deleteRejectedUploadObjects(['files/b', 'uploads/b'], async (key) => {
      attempted.push(key)
      if (key === 'files/b') throw new Error('S3 unavailable')
    })).toBe(false)
    expect(attempted).toEqual(['files/b', 'uploads/b'])
  })
})
