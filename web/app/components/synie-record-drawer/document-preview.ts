import type { DocumentPreviewConfig } from '~/lib/resources/presentation/types'

export type {
  DocumentPreviewConfig,
  DocumentPreviewLineTable,
} from '~/lib/resources/presentation/types'

const registry = new Map<string, DocumentPreviewConfig>()

/** 登记资源只读速览；同 key 后写覆盖（便于测试/热更） */
export function registerDocumentPreview(
  resource: string,
  config: DocumentPreviewConfig,
): void {
  registry.set(resource, config)
}

export function getDocumentPreview(
  resource: string,
): DocumentPreviewConfig | null {
  return registry.get(resource) ?? null
}

/** 已登记资源键（测试/调试） */
export function listDocumentPreviewKeys(): string[] {
  return [...registry.keys()].sort()
}
