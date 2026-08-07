/**
 * 资源显示标签的同步入口：资源事实清单（server meta label 的构建期派生物，
 * ADR 2026-08-07-resource-manifest）。requireWriter 报错、toast 文案等
 * 同步消费点一律从这里取，不再手抄中文字面量；清单外兜底资源名本身。
 */
import { RESOURCE_MANIFEST } from '@synie/shared/generated/resource-manifest'

export function resourceLabel(resource: string): string {
  return RESOURCE_MANIFEST[resource]?.label ?? resource
}
