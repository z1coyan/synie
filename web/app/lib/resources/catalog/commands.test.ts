import { describe, expect, test } from 'bun:test'
import {
  createCommandAdapter,
  decodeBulkTarget,
  decodeCollectionTarget,
  decodeRowOrBulkTarget,
  decodeRowTarget,
  defineCommand,
} from './commands'
import { storageCommandAdapter } from '../files'
import { attendanceDayCommandAdapter } from '../hr-operations'
import { bankTransactionCommandAdapter } from '../finance-operations'

describe('Command target 解码 fail-closed', () => {
  test('row：恰好一个 id；拒绝 ids / 空 / 非对象', () => {
    expect(decodeRowTarget({ id: 'a' })).toBe('a')
    expect(() => decodeRowTarget({ ids: ['a'] })).toThrow(/不接受 ids/)
    expect(() => decodeRowTarget({ id: '' })).toThrow(/非空/)
    expect(() => decodeRowTarget(null)).toThrow(/对象/)
    expect(() => decodeRowTarget({})).toThrow(/非空/)
  })

  test('bulk：非空 ids；空数组失败', () => {
    expect(decodeBulkTarget({ ids: ['a', 'b'] })).toEqual(['a', 'b'])
    expect(() => decodeBulkTarget({ ids: [] })).toThrow(/不可为空/)
    expect(() => decodeBulkTarget({ id: 'a' })).toThrow(/非空 ids/)
    expect(() => decodeBulkTarget({})).toThrow(/非空 ids/)
  })

  test('rowOrBulk：至少一个 id', () => {
    expect(decodeRowOrBulkTarget({ id: 'x' })).toEqual(['x'])
    expect(decodeRowOrBulkTarget({ ids: ['x'] })).toEqual(['x'])
    expect(() => decodeRowOrBulkTarget({ ids: [] })).toThrow(/不可为空/)
  })

  test('collection：不接受伪造记录 target；允许领域 payload', () => {
    expect(decodeCollectionTarget({ dateFrom: '2026-01-01', dateTo: '2026-01-31' })).toEqual({
      dateFrom: '2026-01-01',
      dateTo: '2026-01-31',
    })
    expect(() => decodeCollectionTarget({ id: 'x' })).toThrow(/不需要记录 ID/)
    expect(() => decodeCollectionTarget({ ids: ['x'] })).toThrow(/不需要记录 ID/)
    expect(decodeCollectionTarget({})).toEqual({})
  })
})

describe('已迁移语义 CommandAdapter 契约', () => {
  test('setDefault：row target，语义 key 与 capability 分离', async () => {
    expect(storageCommandAdapter.commands.setDefault.target).toBe('row')
    expect(Object.keys(storageCommandAdapter.commands)).toEqual(['setDefault'])
    // 非法 target 在 execute 边界失败（不发起 transport）
    await expect(
      storageCommandAdapter.execute('setDefault', { ids: ['a'] } as never),
    ).rejects.toThrow(/不接受 ids/)
  })

  test('recalc：collection target，不要求记录 ID', async () => {
    expect(attendanceDayCommandAdapter.commands.recalc.target).toBe('collection')
    expect(Object.keys(attendanceDayCommandAdapter.commands)).toEqual(['recalc'])
    await expect(
      attendanceDayCommandAdapter.execute('recalc', { id: 'fake' } as never),
    ).rejects.toThrow(/不需要记录 ID/)
    await expect(
      attendanceDayCommandAdapter.execute('recalc', {
        dateFrom: 'bad',
        dateTo: '2026-01-01',
      } as never),
    ).rejects.toThrow(/dateFrom/)
  })

  test('reconcile：语义 key 非 export；row target', async () => {
    expect(bankTransactionCommandAdapter.commands.reconcile.target).toBe('row')
    expect(Object.keys(bankTransactionCommandAdapter.commands)).toEqual(['reconcile'])
    expect('export' in bankTransactionCommandAdapter.commands).toBe(false)
    await expect(
      bankTransactionCommandAdapter.execute('reconcile', { ids: ['a'] } as never),
    ).rejects.toThrow()
    await expect(
      bankTransactionCommandAdapter.execute('reconcile', { id: 'a' } as never),
    ).rejects.toThrow(/journalId/)
  })

  test('createCommandAdapter 未知 key 失败', async () => {
    const adapter = createCommandAdapter({
      ping: defineCommand('collection', async () => 'pong'),
    })
    await expect(adapter.execute('ping', {})).resolves.toBe('pong')
    await expect(adapter.execute('missing' as 'ping', {})).rejects.toThrow(/未知命令/)
  })
})
