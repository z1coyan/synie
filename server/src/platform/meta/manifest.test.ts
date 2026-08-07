/**
 * 资源事实清单漂移对拍：sealed Registry 重算结果必须与提交进
 * packages/shared/src/generated/resource-manifest.ts 的生成物逐字节一致。
 * 改 server meta 后重跑 `bun run -F @synie/server gen:manifest`（ADR
 * 2026-08-07-resource-manifest D3）；禁止手改生成物。
 */
import { describe, expect, test } from 'bun:test'
import { RESOURCE_MANIFEST } from '@synie/shared/generated/resource-manifest'
import { buildResourceManifest, serializeResourceManifest } from './manifest.ts'
import { createSealedResourceRegistry } from './register-all.ts'

describe('资源事实清单', () => {
  const registry = createSealedResourceRegistry()
  const rebuilt = buildResourceManifest(registry)

  test('生成物与 sealed Registry 重算一致（漂移即红）', () => {
    expect(serializeResourceManifest(RESOURCE_MANIFEST)).toBe(
      serializeResourceManifest(rebuilt),
    )
  })

  test('覆盖全部目录资源', () => {
    expect(Object.keys(rebuilt).length).toBe(registry.catalogStats().total)
  })

  test('wire 派生规则：decimal/date/decimalZero', () => {
    // 借贷金额空值发 '0'（FieldMeta.decimalEmpty = 'zero'，ADR D4）
    expect(rebuilt.accGlJournalLines!.wire.decimalZero).toEqual(['debit', 'credit'])
    expect(rebuilt.accGlJournalLines!.wire.decimal).toContain('debit')
    // meta type 'date' 的 wire 形态是 ISO datetime（ADR D5 现状固化）
    expect(rebuilt.invStockDocs!.wire.date).toContain('docDate')
    expect(rebuilt.salOrderItems!.wire.decimal).toEqual(
      expect.arrayContaining(['qty', 'price', 'taxRate']),
    )
  })

  test('label 与 lookup 取自规范化结果', () => {
    expect(rebuilt.basCurrencies!.label).toBe('货币')
    expect(rebuilt.hrEmployees!.lookup.searchFields).toEqual(['name', 'code', 'attendanceNo'])
  })
})
