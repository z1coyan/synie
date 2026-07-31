import {
  listPresentationResources,
  presentationFor,
} from '~/lib/resources/presentation/registry'
import type { ResourceDrawerConfig } from '~/lib/resources/presentation/types'

/**
 * Presentation Extension 抽屉薄 Adapter。
 *
 * 重访 resource-catalog issue 12：仍只暴露 21 个实际调用资源，业务 JSX、字段
 * override 与 document preview 已迁回对应业务 module。Basic Form 不经本入口。
 */
export type { ResourceDrawerConfig } from '~/lib/resources/presentation/types'

function drawerFromPresentation(resource: string): ResourceDrawerConfig {
  const presentation = presentationFor(resource)
  return {
    label: presentation.label,
    exclude: presentation.exclude,
    fields: presentation.fields,
    contentClassName: presentation.contentClassName,
    extraContent: presentation.extraContent,
    tabs: presentation.tabs,
  }
}

/**
 * 取 Presentation Extension 抽屉配置。
 * 未知资源 fail-closed（禁止 label=resourceName 静默 fallback）。
 */
export function drawerConfig(
  resource: string,
  extra?: Partial<ResourceDrawerConfig>,
): ResourceDrawerConfig {
  const base = drawerFromPresentation(resource)
  if (!extra) return base
  return {
    ...base,
    ...extra,
    fields: { ...base.fields, ...extra.fields },
  }
}

/** 基线报告：已声明 PE 抽屉的资源键。 */
export function listDrawerConfigKeys(): string[] {
  return listPresentationResources()
}
