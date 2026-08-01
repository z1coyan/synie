import { describe, expect, test } from 'bun:test'
import { assertBankImportRowLimit } from './bank-import'

describe('bank import limits', () => {
  test('accepts 5,000 rows and rejects 5,001', () => {
    expect(() => assertBankImportRowLimit(5_000)).not.toThrow()
    expect(() => assertBankImportRowLimit(5_001)).toThrow('5000 行')
  })
})
