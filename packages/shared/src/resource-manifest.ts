/**
 * 资源事实清单（Resource Manifest）——actor 无关静态事实的唯一构建期载体。
 * 见 ADR docs/系统架构/adr/2026-08-07-resource-manifest.md。
 *
 * 数据本体在 ./generated/resource-manifest.ts（server sealed Registry 派生，
 * 生成物入库 + server 漂移测试对拍，禁止手改）；本文件只放类型与消费助手。
 */
import type { ResourceLookupMeta } from './resource-document.ts'

/** 写体 wire 编码清单（apiName）；只作用于输入里出现的键 */
export interface ResourceWireEncoding {
  /** decimal 字段：出现的值收口为 wire string；空值默认 null，decimalZero 成员发 '0' */
  readonly decimal: readonly string[]
  /** date/datetime 字段：出现的 YYYY-MM-DD 值转 T00:00:00Z ISO datetime */
  readonly date: readonly string[]
  /** 空值发 '0' 的 decimal 字段（借贷金额口径；FieldMeta.decimalEmpty = 'zero'） */
  readonly decimalZero: readonly string[]
}

export interface ResourceManifestEntry {
  /** 独立显示标签（meta.label ?? permissionLabel） */
  readonly label: string
  /** 规范化 lookup（seal 校验后的唯一真值） */
  readonly lookup: ResourceLookupMeta
  readonly wire: ResourceWireEncoding
}

export type ResourceManifest = Readonly<Record<string, ResourceManifestEntry>>
