/**
 * Presentation Extension / AggregateDraftAdapter 契约：
 * Catalog、Presentation、transport Adapter、领域写 seam 所有权分离。
 */
import { describe, expect, test } from 'bun:test'
import type { ResourceDocument } from '@synie/shared'
import { bindingFromResourceTransport } from '../catalog'
import type { AggregateDraftAdapter, ResourceBinding } from '../catalog/types'
import type { ResourceClient } from '../types'
import {
  createAccountPresentation,
  createEmployeePresentation,
  createInvoicePresentation,
  createMaterialPresentation,
  EMPLOYEE_RESOURCE,
  invoiceOcrRecognize,
  MATERIAL_RESOURCE,
  VAT_INVOICE_RESOURCE,
} from './index'
import { salesDeliveryDraftAdapter } from '../fulfillment'

function mockClient(resource: string): ResourceClient {
  return {
    id: `rest:${resource}`,
    query: async () => ({ count: 0, results: [] }),
    get: async (id) => ({ id }),
    create: async (input) => ({ id: 'new-id', ...input }),
    update: async (id, input) => ({ id, ...input }),
    delete: async () => {},
  }
}

function extensionDoc(name: string, label: string): ResourceDocument {
  return {
    schemaVersion: 2,
    name,
    label,
    permissionPrefix: 'test',
    capabilities: ['create', 'update', 'delete'],
    fields: [
      {
        kind: 'scalar',
        scalarType: 'string',
        name: 'name',
        label: '名称',
        visibility: 'readable',
        input: { create: 'required', update: 'allowed' },
        filterable: true,
        sortable: true,
        searchable: true,
      },
    ],
    lookup: { labelField: 'name', searchFields: ['name'] },
    list: { columns: ['name'] },
    form: { kind: 'extension' },
    commands: [],
  }
}

describe('Presentation Extension 与 AggregateDraftAdapter 契约', () => {
  test('发票 PE：OCR seam 共置；ResourceDocument 不含可执行代码', () => {
    const pe = createInvoicePresentation(
      bindingFromResourceTransport(
        VAT_INVOICE_RESOURCE,
        mockClient(VAT_INVOICE_RESOURCE),
      ),
    )
    expect(pe.kind).toBe('extension')
    expect(pe.resource).toBe(VAT_INVOICE_RESOURCE)

    const recognize = invoiceOcrRecognize(pe)
    expect(typeof recognize).toBe('function')

    // Catalog JSON 侧：form.kind=extension，无 component/script 槽
    const doc = extensionDoc(VAT_INVOICE_RESOURCE, '增值税发票')
    expect(doc.form.kind).toBe('extension')
    const wire = JSON.stringify(doc)
    expect(wire).not.toMatch(
      /function|=>|React|ocrVatInvoice|componentPath|script/,
    )
    expect(JSON.parse(wire).form).toEqual({ kind: 'extension' })
  })

  test('员工 PE：身份证影像 extraContent；物料 PE：tabs+effects 静态面', () => {
    const emp = createEmployeePresentation(
      bindingFromResourceTransport(
        EMPLOYEE_RESOURCE,
        mockClient(EMPLOYEE_RESOURCE),
      ),
    )
    expect(emp.kind).toBe('extension')
    expect(typeof emp.extraContent).toBe('function')
    expect(emp.fields.name?.required).toBe(true)
    expect(emp.fields.code).toMatchObject({
      required: false,
      placeholder: '留空自动编号',
    })
    expect(emp.fields.code?.edit).toBeUndefined()

    const mat = createMaterialPresentation(
      bindingFromResourceTransport(
        MATERIAL_RESOURCE,
        mockClient(MATERIAL_RESOURCE),
      ),
    )
    expect(mat.kind).toBe('extension')
    expect(mat.tabs.map((t) => t.key)).toEqual(['basic', 'units'])
    expect(typeof mat.fields.isCustomerMaterial?.effects).toBe('function')
    expect(mat.fields.categoryId?.remote?.filterState).toEqual({
      isLeaf: { kind: 'bool', eq: true },
      active: { kind: 'bool', eq: true },
    })

    const acc = createAccountPresentation(
      bindingFromResourceTransport('basAccounts', mockClient('basAccounts')),
    )
    expect(acc.kind).toBe('extension')
    expect(typeof acc.fields.isGroup?.effects).toBe('function')
    expect(typeof acc.fields.role?.visible).toBe('function')
  })

  test('销售发货 binding：拥有 AggregateDraftAdapter，表单不暴露 RecordWriter create/update', () => {
    const client = mockClient('salDeliveries')
    // 与 registry 一致：无 create/update writer，挂 draft
    const base = bindingFromResourceTransport('salDeliveries', client, {
      canCreate: false,
      canUpdate: false,
      canDelete: true,
    })
    const draft: AggregateDraftAdapter<
      Record<string, unknown>,
      {
        id: string
        items: Array<{ id: string; idx: number }>
        packBoxes: unknown[]
      }
    > = {
      loadDraft: async (id) => ({
        id,
        items: Array.from({ length: 250 }, (_, i) => ({
          id: `i${i}`,
          idx: i + 1,
        })),
        packBoxes: [],
      }),
      createDraft: async (input) => ({
        id: 'd1',
        ...(input as object),
        items: [],
        packBoxes: [],
      }),
      replaceDraft: async (id, input) => ({
        id,
        ...(input as object),
        items: [],
        packBoxes: [],
      }),
    }
    const binding: ResourceBinding = { ...base, draft }
    expect(binding.draft).toBeDefined()
    expect(
      binding.writer &&
        'create' in binding.writer &&
        (binding.writer as { create?: unknown }).create,
    ).toBeFalsy()
    expect(
      binding.writer &&
        'update' in binding.writer &&
        (binding.writer as { update?: unknown }).update,
    ).toBeFalsy()
    expect(binding.writer && 'delete' in binding.writer).toBe(true)

    // loadDraft 完整返回超过默认分页数量的子记录
    return binding.draft!.loadDraft('x').then((saved) => {
      const items = (saved as { items: unknown[] }).items
      expect(items).toHaveLength(250)
    })
  })

  test('生产 salesDeliveryDraftAdapter 具备 load/create/replace 三方法', () => {
    expect(typeof salesDeliveryDraftAdapter.loadDraft).toBe('function')
    expect(typeof salesDeliveryDraftAdapter.createDraft).toBe('function')
    expect(typeof salesDeliveryDraftAdapter.replaceDraft).toBe('function')
  })

  test('所有权分离：Catalog 不持 Adapter；PE 持 binding；Adapter 不声明 form.kind', () => {
    const binding: ResourceBinding = {
      ...bindingFromResourceTransport(
        EMPLOYEE_RESOURCE,
        mockClient(EMPLOYEE_RESOURCE),
      ),
    }
    const pe = createEmployeePresentation(binding)

    // Catalog 文档无 transport
    const catalog = extensionDoc(EMPLOYEE_RESOURCE, '员工')
    expect('draft' in catalog).toBe(false)
    expect('writer' in catalog).toBe(false)
    expect('reader' in catalog).toBe(false)

    // PE 持 binding 引用，不自建 client
    expect(pe.binding.resource).toBe(EMPLOYEE_RESOURCE)
    expect(pe.binding.reader).toBeDefined()

    // Adapter 是 transport，不是 Meta
    expect(salesDeliveryDraftAdapter).not.toHaveProperty('form')
    expect(salesDeliveryDraftAdapter).not.toHaveProperty('schemaVersion')
  })
})
