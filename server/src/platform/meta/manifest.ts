/**
 * 资源事实清单（Resource Manifest）派生：sealed Registry → actor 无关静态事实。
 * 见 ADR docs/系统架构/adr/2026-08-07-resource-manifest.md（D2 内容边界、D5 派生规则）。
 *
 * 生成脚本 server/scripts/generate-resource-manifest.ts 落盘进 packages/shared；
 * manifest.test.ts 漂移对拍兜底。禁止手改生成物。
 */
import type { ResourceManifest, ResourceManifestEntry } from '@synie/shared'
import type { Registry } from './registry.ts'

/** 派生规则（ADR D5）：decimal → wire.decimal；date/datetime → wire.date；decimalEmpty='zero' → wire.decimalZero */
export function buildResourceManifest(registry: Registry): ResourceManifest {
  const manifest: Record<string, ResourceManifestEntry> = {}
  for (const meta of registry.list()) {
    const norm = registry.normalizedResource(meta.name)
    if (!norm) {
      throw new Error(`Meta 资源 ${meta.name} 缺少规范化结果（manifest 须在 seal 后派生）`)
    }
    const decimal: string[] = []
    const date: string[] = []
    const decimalZero: string[] = []
    for (const field of meta.fields) {
      if (field.type === 'decimal') {
        decimal.push(field.apiName)
        if (field.decimalEmpty === 'zero') decimalZero.push(field.apiName)
      } else if (field.type === 'date' || field.type === 'datetime') {
        date.push(field.apiName)
      }
    }
    manifest[meta.name] = { label: norm.label, lookup: norm.lookup, wire: { decimal, date, decimalZero } }
  }
  return Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)))
}

/** 生成物的确定性序列化（脚本落盘与漂移对拍共用同一格式） */
export function serializeResourceManifest(manifest: ResourceManifest): string {
  return `/**
 * 资源事实清单（Resource Manifest）——由 server/scripts/generate-resource-manifest.ts
 * 从 sealed Registry 派生（ADR 2026-08-07-resource-manifest）。禁止手改：
 * 改 server meta 后重跑 bun run -F @synie/server gen:manifest；漂移测试对拍兜底。
 */
import type { ResourceManifest } from '../resource-manifest.ts'

export const RESOURCE_MANIFEST: ResourceManifest = ${JSON.stringify(manifest, null, 2)}
`
}
