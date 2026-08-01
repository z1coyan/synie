import { describe, expect, test } from 'bun:test'
import { allResourceDocuments } from '../../catalog/all'
import {
  PRINT_RESOURCE_DEFINITIONS,
  fieldCatalog,
  printableResources,
  validatePlaceholders,
} from './catalog'

describe('Convex printing field catalog', () => {
  test('covers every active DocBuilder resource and only those resources', () => {
    expect(printableResources()).toEqual(Object.keys(PRINT_RESOURCE_DEFINITIONS).sort())
    for (const resource of printableResources()) {
      const definition = PRINT_RESOURCE_DEFINITIONS[resource]
      const document = allResourceDocuments[definition.head]
      expect(document.permissionPrefix).toBe(resource)
      expect(document.capabilities).toContain('print')
      expect(document.capabilities).toContain('export')
      expect(fieldCatalog(resource)?.loops.map((loop) => loop.name).sort())
        .toEqual(Object.keys(definition.loops).sort())
    }
  })

  test('derives stable legacy placeholder names from sealed camelCase Catalog', () => {
    const sales = fieldCatalog('sales.order')!
    expect(sales.fields.map((field) => field.name)).toContain('order_no')
    expect(sales.fields.map((field) => field.name)).toContain('company.name')
    expect(sales.fields.map((field) => field.name)).not.toContain('id')
    expect(sales.loops.find((loop) => loop.name === 'items')?.fields.map((field) => field.name))
      .toContain('material.name')
  })

  test('fails closed for unknown placeholders', () => {
    expect(() => validatePlaceholders('sales.order', {
      fields: ['order_no'], nested: { items: ['qty', '_seq'] },
    })).not.toThrow()
    expect(() => validatePlaceholders('sales.order', {
      fields: ['secret'], nested: {},
    })).toThrow('未知字段')
  })
})
