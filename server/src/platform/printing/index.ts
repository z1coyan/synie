import type { Registry } from '../meta/registry.ts'
import { createFieldCatalog } from './catalog.ts'
import { printTemplateResourceMeta } from './meta.ts'

export { createFieldCatalog, type FieldCatalog } from './catalog.ts'
export { createPrintingService, type PrintingService } from './service.ts'
export { systemPrintingRoutes, printingRoutes } from './routes.ts'
export { printTemplateResourceMeta, RESOURCE_NAME, PERMISSION_PREFIX } from './meta.ts'
export { createSofficeConverter } from './pdf.ts'
export type { DocBuilder, DocBuilderMap } from './docbuilder.ts'
export { renderPages, renderSheets, ERR_EMPTY_DOCS } from './renderer.ts'
export { extractPlaceholders } from './xlsx.ts'
export type * from './types.ts'

/** Meta + 附件宿主（业务资源 Meta 由各域 register*Resources 注册；打印目录 fail-closed 派生） */
export function registerPrintingResources(registry: Registry): void {
  registry.register(printTemplateResourceMeta())
}

/** 从当前 Registry 构建打印字段目录（启动期调用） */
export function buildPrintingCatalog(registry: Registry) {
  return createFieldCatalog(registry)
}
