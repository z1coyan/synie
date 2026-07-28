import type { Registry } from '../meta/registry.ts'
import type { OwnerRegistry } from '../files/owner-registry.ts'
import { createFieldCatalog } from './catalog.ts'
import { registerPrintCatalogStubs } from './catalog-stubs.ts'
import { printTemplateResourceMeta } from './meta.ts'
import { registerSalesOrderPrintMetas } from './sales-order-meta.ts'

export { createFieldCatalog, type FieldCatalog } from './catalog.ts'
export { createPrintingService, canUseTemplates, type PrintingService } from './service.ts'
export { systemPrintingRoutes, printingRoutes } from './routes.ts'
export { printTemplateResourceMeta, RESOURCE_NAME, PERMISSION_PREFIX } from './meta.ts'
export { createSofficeConverter, createSofficeConverterFromEnv } from './pdf.ts'
export { renderPages, renderSheets, ERR_EMPTY_DOCS } from './renderer.ts'
export { extractPlaceholders } from './xlsx.ts'
export { registerSalesOrderPrintMetas } from './sales-order-meta.ts'
export type * from './types.ts'

/** Meta + 附件宿主 + 字段目录依赖资源 */
export function registerPrintingResources(registry: Registry): void {
  registerSalesOrderPrintMetas(registry)
  registerPrintCatalogStubs(registry)
  registry.register(printTemplateResourceMeta())
}

export function registerPrintingFileOwners(owners: OwnerRegistry): void {
  owners.register('sys_print_template', {
    table: 'sys_print_template',
    permissionPrefix: 'sys.print_template',
  })
}

/** 从当前 Registry 构建打印字段目录（启动期调用） */
export function buildPrintingCatalog(registry: Registry) {
  return createFieldCatalog(registry)
}
