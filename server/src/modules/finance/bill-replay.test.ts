import { describe, expect, test } from 'bun:test'
import { ApiError } from '~/platform/http/errors.ts'
import {
  replaySegments,
  segmentAmount,
  totalSegmentCents,
  type ReplayTx,
} from './bill-replay.ts'

const coA = 'co-a'
const coB = 'co-b'
const bank1 = 'bank-1'
const bank2 = 'bank-2'

function tx(partial: Partial<ReplayTx> & Pick<ReplayTx, 'id' | 'transactionType' | 'subStart' | 'subEnd'>): ReplayTx {
  return {
    docNo: partial.docNo ?? partial.id,
    occurredOn: partial.occurredOn ?? '2026-01-15',
    companyId: partial.companyId ?? coA,
    bankAccountId: partial.bankAccountId ?? bank1,
    toBankAccountId: partial.toBankAccountId ?? null,
    ...partial,
  }
}

function conflictMsg(err: unknown): string {
  expect(err).toBeInstanceOf(ApiError)
  const e = err as ApiError
  expect(e.code).toBe('conflict')
  return e.message
}

describe('replaySegments', () => {
  test('接收整段入库存', () => {
    const segs = replaySegments([
      tx({ id: 'r1', transactionType: 'receive', subStart: 1, subEnd: 100_000 }),
    ])
    expect(segs).toEqual([
      {
        companyId: coA,
        bankAccountId: bank1,
        start: 1,
        end: 100_000,
        acquiredOn: '2026-01-15',
        sourceId: 'r1',
      },
    ])
    expect(segmentAmount(1, 100_000)).toBe('1000')
    expect(totalSegmentCents(segs)).toBe(100_000)
  })

  test('接收段重叠拒绝（跨账户）', () => {
    try {
      replaySegments([
        tx({ id: 'r1', transactionType: 'receive', subStart: 1, subEnd: 100 }),
        tx({
          id: 'r2',
          transactionType: 'receive',
          subStart: 50,
          subEnd: 150,
          bankAccountId: bank2,
          companyId: coB,
        }),
      ])
      expect.unreachable()
    } catch (err) {
      expect(conflictMsg(err)).toContain('接收段与现有持有段重叠')
      expect(conflictMsg(err)).toContain('r2')
    }
  })

  test('部分转让：拆段 + 金额守恒', () => {
    const segs = replaySegments([
      tx({ id: 'r1', transactionType: 'receive', subStart: 1, subEnd: 100_000 }),
      tx({ id: 'e1', transactionType: 'endorse', subStart: 1, subEnd: 50_000 }),
    ])
    expect(segs).toHaveLength(1)
    expect(segs[0]).toMatchObject({ start: 50_001, end: 100_000, sourceId: 'r1' })
    expect(totalSegmentCents(segs)).toBe(50_000)
    expect(segmentAmount(50_001, 100_000)).toBe('500')
  })

  test('横跨多段消耗 + 中间缺口拒绝', () => {
    // 先收两段再背书中间缺口
    try {
      replaySegments([
        tx({ id: 'r1', transactionType: 'receive', subStart: 1, subEnd: 100 }),
        tx({ id: 'r2', transactionType: 'receive', subStart: 201, subEnd: 300 }),
        tx({ id: 'e1', transactionType: 'endorse', subStart: 50, subEnd: 250 }),
      ])
      expect.unreachable()
    } catch (err) {
      expect(conflictMsg(err)).toMatch(/段 101-200 未持有/)
    }
  })

  test('未持有段拒绝（完全未持有）', () => {
    try {
      replaySegments([
        tx({ id: 'r1', transactionType: 'receive', subStart: 1, subEnd: 100 }),
        tx({ id: 's1', transactionType: 'settle', subStart: 200, subEnd: 300 }),
      ])
      expect.unreachable()
    } catch (err) {
      expect(conflictMsg(err)).toMatch(/段 200-300 未持有/)
    }
  })

  test('调拨换户：转出消耗、转入加段、取得日记调拨日', () => {
    const segs = replaySegments([
      tx({
        id: 'r1',
        transactionType: 'receive',
        subStart: 1,
        subEnd: 10_000,
        occurredOn: '2026-01-01',
      }),
      tx({
        id: 'x1',
        transactionType: 'reallocate',
        subStart: 1,
        subEnd: 10_000,
        occurredOn: '2026-02-01',
        toBankAccountId: bank2,
      }),
    ])
    expect(segs).toHaveLength(1)
    expect(segs[0]).toEqual({
      companyId: coA,
      bankAccountId: bank2,
      start: 1,
      end: 10_000,
      acquiredOn: '2026-02-01',
      sourceId: 'x1',
    })
    expect(totalSegmentCents(segs)).toBe(10_000)
  })

  test('调拨缺少转入账户拒绝', () => {
    try {
      replaySegments([
        tx({ id: 'r1', transactionType: 'receive', subStart: 1, subEnd: 100 }),
        tx({ id: 'x1', transactionType: 'reallocate', subStart: 1, subEnd: 100, toBankAccountId: null }),
      ])
      expect.unreachable()
    } catch (err) {
      expect(conflictMsg(err)).toBe('承兑库存校验失败:调拨缺少转入账户')
    }
  })

  test('部分调拨：余段留原账户与来源，调拨段换户', () => {
    const segs = replaySegments([
      tx({ id: 'r1', transactionType: 'receive', subStart: 1, subEnd: 1000, occurredOn: '2026-01-01' }),
      tx({
        id: 'x1',
        transactionType: 'reallocate',
        subStart: 1,
        subEnd: 400,
        occurredOn: '2026-03-01',
        toBankAccountId: bank2,
      }),
    ])
    expect(segs).toHaveLength(2)
    const byBank = Object.fromEntries(segs.map((s) => [s.bankAccountId, s]))
    expect(byBank[bank1]).toMatchObject({
      start: 401,
      end: 1000,
      acquiredOn: '2026-01-01',
      sourceId: 'r1',
    })
    expect(byBank[bank2]).toMatchObject({
      start: 1,
      end: 400,
      acquiredOn: '2026-03-01',
      sourceId: 'x1',
    })
    expect(totalSegmentCents(segs)).toBe(1000)
  })

  test('贴现/兑付耗尽后库存为空', () => {
    const segs = replaySegments([
      tx({ id: 'r1', transactionType: 'receive', subStart: 1, subEnd: 500 }),
      tx({ id: 'd1', transactionType: 'discount', subStart: 1, subEnd: 500 }),
    ])
    expect(segs).toEqual([])
    expect(totalSegmentCents(segs)).toBe(0)
  })

  test('作废语义：去掉末笔交易后重放 = 回滚库存', () => {
    const audited = [
      tx({ id: 'r1', transactionType: 'receive', subStart: 1, subEnd: 1000 }),
      tx({ id: 'e1', transactionType: 'endorse', subStart: 1, subEnd: 300 }),
    ]
    const afterEndorse = replaySegments(audited)
    expect(totalSegmentCents(afterEndorse)).toBe(700)
    // void e1 → 仅 r1 仍 audited
    const afterVoid = replaySegments(audited.slice(0, 1))
    expect(totalSegmentCents(afterVoid)).toBe(1000)
    expect(afterVoid[0]).toMatchObject({ start: 1, end: 1000, sourceId: 'r1' })
  })

  test('他户持有不被本方消耗', () => {
    const segs = replaySegments([
      tx({ id: 'r1', transactionType: 'receive', subStart: 1, subEnd: 100, bankAccountId: bank1 }),
      // 另一账户已无法 receive 重叠段；用 reallocate 换户后再尝试从 bank1 消耗应失败
      tx({
        id: 'x1',
        transactionType: 'reallocate',
        subStart: 1,
        subEnd: 100,
        bankAccountId: bank1,
        toBankAccountId: bank2,
      }),
    ])
    expect(segs[0]!.bankAccountId).toBe(bank2)
    try {
      replaySegments([
        ...[
          tx({ id: 'r1', transactionType: 'receive', subStart: 1, subEnd: 100, bankAccountId: bank1 }),
          tx({
            id: 'x1',
            transactionType: 'reallocate',
            subStart: 1,
            subEnd: 100,
            bankAccountId: bank1,
            toBankAccountId: bank2,
          }),
        ],
        tx({ id: 'e1', transactionType: 'endorse', subStart: 1, subEnd: 100, bankAccountId: bank1 }),
      ])
      expect.unreachable()
    } catch (err) {
      expect(conflictMsg(err)).toMatch(/未持有/)
    }
  })
})
