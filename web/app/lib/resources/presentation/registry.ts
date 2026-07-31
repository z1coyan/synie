/**
 * Presentation Extension 薄装配。
 *
 * 这里只关联资源键与业务域 factory；Drawer、preview、React 与业务差异全部留在
 * 各业务域 module。未知资源 fail-closed。
 */
import type { ResourceBinding } from '../catalog/types'
import { resourceBindingFor } from '../registry'
import {
  ACCOUNTING_PRESENTATION_RESOURCES,
  createAccountingPresentation,
} from './accounting-presentations'
import {
  createHrPresentation,
  HR_PRESENTATION_RESOURCES,
} from './hr-presentations'
import {
  createInventoryDocumentPresentation,
  INVENTORY_DOCUMENT_RESOURCES,
} from './inventory-documents'
import {
  createManufacturingDocumentPresentation,
  MANUFACTURING_DOCUMENT_RESOURCES,
} from './manufacturing-documents'
import {
  createPurchaseDocumentPresentation,
  PURCHASE_DOCUMENT_RESOURCES,
} from './purchase-documents'
import {
  createSalesDocumentPresentation,
  SALES_DOCUMENT_RESOURCES,
} from './sales-documents'
import {
  createSystemPresentation,
  SYSTEM_PRESENTATION_RESOURCES,
} from './system-presentations'
import type { PresentationExtension } from './types'

type PresentationFactory = (binding: ResourceBinding) => PresentationExtension

const GROUPS: ReadonlyArray<{
  resources: readonly string[]
  create: PresentationFactory
}> = [
  {
    resources: INVENTORY_DOCUMENT_RESOURCES,
    create: createInventoryDocumentPresentation,
  },
  {
    resources: SALES_DOCUMENT_RESOURCES,
    create: createSalesDocumentPresentation,
  },
  {
    resources: PURCHASE_DOCUMENT_RESOURCES,
    create: createPurchaseDocumentPresentation,
  },
  {
    resources: MANUFACTURING_DOCUMENT_RESOURCES,
    create: createManufacturingDocumentPresentation,
  },
  {
    resources: HR_PRESENTATION_RESOURCES,
    create: createHrPresentation,
  },
  {
    resources: ACCOUNTING_PRESENTATION_RESOURCES,
    create: createAccountingPresentation,
  },
  {
    resources: SYSTEM_PRESENTATION_RESOURCES,
    create: createSystemPresentation,
  },
]

const factories = new Map<string, PresentationFactory>()
for (const group of GROUPS) {
  for (const resource of group.resources) {
    if (factories.has(resource)) {
      throw new Error(`重复 Presentation Extension 资源「${resource}」`)
    }
    factories.set(resource, group.create)
  }
}

/**
 * 取完整 Presentation Extension。
 * Basic/none/未知资源都显式失败，不回落到 Catalog label 或空配置。
 */
export function presentationFor(resource: string): PresentationExtension {
  const create = factories.get(resource)
  if (!create) {
    throw new Error(
      `资源「${resource}」无 Presentation Extension；basic 请用 basicFormDrawerProps，none/只读请仅传 Catalog label`,
    )
  }
  return create(resourceBindingFor(resource))
}

export function listPresentationResources(): string[] {
  return [...factories.keys()].sort()
}
