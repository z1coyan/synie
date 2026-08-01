import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseBankImport } from '@synie/shared'

// fixture 取自归档 Elixir 后端（backend-elixir-final），已收进仓内 testdata
const samplePath = join(import.meta.dir, 'testdata/bank_import_sample.xls')

describe('bank-parser BIFF8', () => {
  test('parses bank_import_sample.xls to 3 rows', () => {
    const content = new Uint8Array(readFileSync(samplePath))
    const items = parseBankImport(
      {
        startRow: 2,
        datetimeCol: null,
        datetimeFormat: null,
        dateCol: 'A',
        dateFormat: 'YMD_DASH',
        timeCol: 'B',
        timeFormat: 'HMS',
        incomeCol: 'C',
        expenseCol: 'D',
        amountCol: null,
        balanceCol: 'E',
        counterpartyNameCol: 'F',
        counterpartyAccountCol: null,
        summaryCol: 'G',
        noteCol: null,
      },
      content,
    )
    expect(items).toHaveLength(3)
    expect(items.every((i) => i.error == null)).toBe(true)
    expect(items[0]!.income).toBe('1234.56')
    expect(items[2]!.expense).toBe('88')
  })
})
