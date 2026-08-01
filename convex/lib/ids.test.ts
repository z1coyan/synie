import { describe, expect, test } from 'bun:test'
import { asOpaqueId, isOpaqueId } from './ids'

describe('opaque Convex ID', () => {
  test('不要求 UUID 外形', () => {
    expect(isOpaqueId('jh7f9ab3opaque')).toBe(true)
    expect(asOpaqueId('jh7f9ab3opaque', 'appUsers')).toBe('jh7f9ab3opaque')
  })

  test('拒绝空值与隐式 trim', () => {
    expect(isOpaqueId('')).toBe(false)
    expect(isOpaqueId('  id')).toBe(false)
    expect(() => asOpaqueId(' ', 'appUsers')).toThrow()
  })
})
