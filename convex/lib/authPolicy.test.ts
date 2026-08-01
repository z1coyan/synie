import { describe, expect, test } from 'bun:test'
import { usesSecureSessionCookies } from './authPolicy'

describe('Better Auth session cookie policy', () => {
  test('HTTPS production origin always enables Secure cookies', () => {
    expect(usesSecureSessionCookies('https://erp.example.com')).toBe(true)
  })

  test('loopback HTTP development origin remains usable', () => {
    expect(usesSecureSessionCookies('http://localhost:3000')).toBe(false)
  })

  test('rejects malformed deployment origins', () => {
    expect(() => usesSecureSessionCookies('not-a-url')).toThrow()
  })
})
