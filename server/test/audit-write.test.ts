import { describe, expect, test } from 'bun:test'
import {
  FILTERED_PLACEHOLDER,
  auditCreated,
  auditDestroyed,
  auditDiff,
  filterSensitive,
} from '~/platform/audit/write.ts'

describe('audit write helpers', () => {
  test('Created/Destroyed 形状与历史日志一致', () => {
    const snapshot = { name: '美元', symbol: null }
    expect(auditCreated(snapshot, ['name', 'symbol'])).toEqual({
      name: { to: '美元' },
      symbol: { to: null },
    })
    expect(auditDestroyed(snapshot, ['name', 'symbol'])).toEqual({
      name: { from: '美元' },
      symbol: { from: null },
    })
  })

  test('Diff 仅包含实际变更', () => {
    const changes = auditDiff(
      { name: '美元', active: true },
      { name: '美金', active: true },
      ['name', 'active'],
    )
    expect(changes).toEqual({ name: { from: '美元', to: '美金' } })
  })

  test('FilterSensitive 脱敏声明字段', () => {
    const sensitive = ['secret']
    const created = filterSensitive(
      auditCreated({ name: '甲', secret: 's3cr3t' }, ['name', 'secret']),
      sensitive,
    )
    expect(created.secret?.to).toBe(FILTERED_PLACEHOLDER)
    expect(created.name?.to).toBe('甲')
  })
})
