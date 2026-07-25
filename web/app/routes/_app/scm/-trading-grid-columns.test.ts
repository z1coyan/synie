import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const FILES = [
  'purchase/items.tsx',
  'purchase-quotations/items.tsx',
  'quotations/items.tsx',
  'sales-orders/items.tsx',
] as const

function gridColumns(file: string): string[] {
  const source = readFileSync(join(import.meta.dirname, file), 'utf8')
  const match = source.match(/const GRID_COLUMNS = \[([\s\S]*?)\]/)
  if (!match) throw new Error(`${file} 缺少 GRID_COLUMNS 白名单`)

  return [...match[1].matchAll(/'([^']+)'/g)].map((item) => item[1])
}

describe('购销条目表公司首列契约', () => {
  for (const file of FILES) {
    test(`${file} 首列为 companyId`, () => {
      expect(gridColumns(file)[0]).toBe('companyId')
    })
  }
})
