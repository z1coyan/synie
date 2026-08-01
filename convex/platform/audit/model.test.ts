import { describe, expect, test } from 'bun:test'
import { boundedAuditChanges, changedFields, redactAuditValue } from './model'

describe('formal audit model', () => {
  test('diff 只保留变化字段', () => {
    expect(changedFields({ a: 1, b: 2 }, { a: 1, b: 3 })).toEqual({ b: { before: 2, after: 3 } })
  })

  test('任意嵌套层级的 secret/token/password/internal email 都脱敏', () => {
    const value = redactAuditValue({
      password: 'p',
      nested: [{ capabilityToken: 't', s3Credential: 'c', internalEmail: 'a@b.test' }],
    })
    const encoded = JSON.stringify(value)
    expect(encoded).not.toContain('"p"')
    expect(encoded).not.toContain('"t"')
    expect(encoded).not.toContain('"c"')
    expect(encoded).not.toContain('a@b.test')
  })

  test('超大 changes 同步写摘要，不拆异步任务', () => {
    const result = boundedAuditChanges({ payload: 'x'.repeat(70_000), normal: 1 })
    expect(result.truncated).toBe(true)
    expect(JSON.stringify(result.changes)).not.toContain('x'.repeat(1_000))
  })
})
