import type { ResourceBinding } from '../catalog/types'
import type {
  DocumentPreviewConfig,
  PresentationExtension,
  ResourceDrawerConfig,
} from './types'

export type PresentationDefinition = ResourceDrawerConfig & {
  readonly documentPreview?: (
    presentation: PresentationExtension,
  ) => DocumentPreviewConfig
}

/**
 * 业务域 Presentation module 的内部装配器。
 *
 * 外部只传 ResourceBinding；资源选择、Drawer 与 preview 的组合全部留在业务域
 * implementation 内。未知 binding 显式失败。
 */
export function presentationFromDefinitions<TResource extends string>(
  binding: ResourceBinding,
  definitions: Record<TResource, PresentationDefinition>,
  groupLabel: string,
): PresentationExtension {
  const definition = definitions[binding.resource as TResource]
  if (!definition) {
    throw new Error(
      `${groupLabel} Presentation Extension 不支持资源「${binding.resource}」`,
    )
  }

  const { documentPreview: createDocumentPreview, ...drawer } = definition
  const presentation: PresentationExtension = {
    ...drawer,
    resource: binding.resource,
    kind: 'extension',
    binding,
    exclude: drawer.exclude ?? [],
    fields: drawer.fields ?? {},
  }
  if (!createDocumentPreview) return presentation
  return {
    ...presentation,
    documentPreview: createDocumentPreview(presentation),
  }
}
