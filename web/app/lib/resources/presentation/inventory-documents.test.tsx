import { describe, expect, test } from 'bun:test'
import type { ResourceDocument } from '@synie/shared'
import { isValidElement } from 'react'
import type { ResourceBinding } from '../catalog/types'
import { createResourceQueryCache } from '../catalog/query-cache'
import {
  drawerConfig,
  listDrawerConfigKeys,
} from '~/components/synie-record-drawer/extension-drawer-props'
import {
  getDocumentPreview,
  listDocumentPreviewKeys,
} from '~/components/synie-record-drawer/document-preview'
import '~/components/synie-record-drawer/document-preview-registry'
import {
  createInventoryDocumentPresentation,
  INVENTORY_DOCUMENT_RESOURCES,
} from './inventory-documents'

function binding(resource: string): ResourceBinding {
  return {
    resource,
    reader: {
      query: async () => ({ results: [], pageInfo: { continueCursor: null, isDone: true } }),
      get: async () => null,
    },
    cache: createResourceQueryCache(resource, `test:${resource}`),
    loadDocument: async () => ({}) as ResourceDocument,
  }
}

describe('其他库存单 Presentation Extension interface', () => {
  test('一个 factory 以 ResourceBinding 构造三类完整呈现', () => {
    for (const resource of INVENTORY_DOCUMENT_RESOURCES) {
      const resourceBinding = binding(resource)
      const presentation = createInventoryDocumentPresentation(resourceBinding)

      expect(presentation.kind).toBe('extension')
      expect(presentation.resource).toBe(resource)
      expect(presentation.binding).toBe(resourceBinding)
      expect(presentation.documentPreview.label).toBe(presentation.label)
      expect(presentation.documentPreview.head.fields).toBe(presentation.fields)
      expect(presentation.documentPreview.head.exclude).toBe(
        presentation.exclude,
      )
      expect(presentation.exclude).toContain('status')
      expect(presentation.documentPreview.lineTables).toHaveLength(1)
      expect(presentation.documentPreview.lineTables[0]?.columns).toContain(
        'materialCode',
      )
    }
  })

  test('错误或未知 binding fail-closed', () => {
    expect(() =>
      createInventoryDocumentPresentation(binding('salDeliveries')),
    ).toThrow(/不支持资源/)
    expect(() =>
      createInventoryDocumentPresentation(binding('__unknown__')),
    ).toThrow(/__unknown__/)
  })

  test('资源差异留在 module implementation 内', () => {
    const stockDocument = createInventoryDocumentPresentation(
      binding('invStockDocs'),
    )
    expect(stockDocument.fields.direction?.defaultValue).toBe('IN')
    expect(stockDocument.fields.direction?.edit).toBe('createOnly')
    expect(stockDocument.documentPreview.lineTables[0]?.parentIdField).toBe(
      'stockDocId',
    )

    const transfer = createInventoryDocumentPresentation(
      binding('invStockTransfers'),
    )
    expect(transfer.fields.fromWarehouseId?.label).toBe('调出仓库')
    expect(
      transfer.documentPreview.lineTables[0]?.overrides?.receivedQty?.label,
    ).toBe('实收数量')

    const count = createInventoryDocumentPresentation(binding('invStockCounts'))
    const countTable = count.documentPreview.lineTables[0]
    expect(countTable?.sortColumn).toBe('insertedAt')
    const renderDifference = countTable?.overrides?.difference?.render
    expect(
      renderDifference?.(null, {
        id: 'positive',
        convertedCounted: 2,
        bookQuantity: 1,
      }),
    ).toBe('1')
    expect(
      isValidElement(
        renderDifference?.(null, {
          id: 'negative',
          convertedCounted: 1,
          bookQuantity: 2,
        }),
      ),
    ).toBe(true)
  })

  test('两个全局 registry 只装配 module 的公开行为并保留键集合', () => {
    const drawerKeys = listDrawerConfigKeys()
    const previewKeys = listDocumentPreviewKeys()

    for (const resource of INVENTORY_DOCUMENT_RESOURCES) {
      const expected = createInventoryDocumentPresentation(binding(resource))
      const drawer = drawerConfig(resource)
      const preview = getDocumentPreview(resource)

      expect(drawer.label).toBe(expected.label)
      expect(drawer.exclude).toEqual(expected.exclude)
      expect(drawer.fields).toEqual(expected.fields)
      expect(preview?.docNoField).toBe(expected.documentPreview.docNoField)
      expect(preview?.lineTables[0]?.resource).toBe(
        expected.documentPreview.lineTables[0]?.resource,
      )
      expect(drawerKeys).toContain(resource)
      expect(previewKeys).toContain(resource)
    }
  })
})
