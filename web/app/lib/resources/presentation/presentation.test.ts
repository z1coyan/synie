/**
 * Presentation Extension / AggregateDraftAdapter 契约：
 * Catalog、Presentation、transport Adapter、领域写 seam 所有权分离。
 */
import { describe, expect, test } from 'bun:test'
import type { ResourceDocument } from '@synie/shared'
import {
  bindingFromResourceClient,
  clearBindingsForTests,
  registerBinding,
  replaceBinding,
  resourceBindingFor,
} from '../catalog'
import type { AggregateDraftAdapter, ResourceBinding } from '../catalog/types'
import type { ResourceClient } from '../types'
import {
  createAccountPresentation,
  createCustomerPresentation,
  createEmployeePresentation,
  createInvoicePresentation,
  createMaterialPresentation,
  CUSTOMER_RESOURCE,
  EMPLOYEE_RESOURCE,
  invoiceOcrRecognize,
  MATERIAL_RESOURCE,
  submitCustomerForm,
  VAT_INVOICE_RESOURCE,
} from './index'
import { salesDeliveryDraftAdapter } from '../fulfillment'

function mockClient(resource: string): ResourceClient {
  return {
    id: `rest:${resource}`,
    meta: async () => ({
      columns: [],
      capabilities: ['create', 'update', 'delete'],
      extendedActions: [],
      destroyMutation: null,
    }),
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
  test('客户 PE：完整 form controller + 附件 extraContent；由 binding 构造', async () => {
    clearBindingsForTests()
    const client = mockClient(CUSTOMER_RESOURCE)
    const binding = bindingFromResourceClient(CUSTOMER_RESOURCE, client)
    registerBinding(binding)

    const pe = createCustomerPresentation(resourceBindingFor(CUSTOMER_RESOURCE))
    expect(pe.kind).toBe('extension')
    expect(pe.resource).toBe(CUSTOMER_RESOURCE)
    expect(pe.binding).toBe(resourceBindingFor(CUSTOMER_RESOURCE))
    expect(pe.fields.code?.required).toBe(true)
    expect(pe.fields.name?.required).toBe(true)
    expect(typeof pe.extraContent).toBe('function')

    // create/edit 经 binding.writer
    const id = await submitCustomerForm(
      pe,
      { code: 'C1', name: '测试客户', shortName: '测' },
      'create',
      undefined,
    )
    expect(id).toBe('new-id')

    // 错误 resource 的 binding 拒绝
    const wrong = bindingFromResourceClient('purSuppliers', mockClient('purSuppliers'))
    expect(() => createCustomerPresentation(wrong)).toThrow(/salCustomers/)
  })

  test('发票 PE：OCR seam 共置；ResourceDocument 不含可执行代码', () => {
    clearBindingsForTests()
    registerBinding(
      bindingFromResourceClient(VAT_INVOICE_RESOURCE, mockClient(VAT_INVOICE_RESOURCE)),
    )
    const pe = createInvoicePresentation(resourceBindingFor(VAT_INVOICE_RESOURCE))
    expect(pe.kind).toBe('extension')
    expect(pe.resource).toBe(VAT_INVOICE_RESOURCE)

    const recognize = invoiceOcrRecognize(pe)
    expect(typeof recognize).toBe('function')

    // Catalog JSON 侧：form.kind=extension，无 component/script 槽
    const doc = extensionDoc(VAT_INVOICE_RESOURCE, '增值税发票')
    expect(doc.form.kind).toBe('extension')
    const wire = JSON.stringify(doc)
    expect(wire).not.toMatch(/function|=>|React|ocrVatInvoice|componentPath|script/)
    expect(JSON.parse(wire).form).toEqual({ kind: 'extension' })
  })

  test('员工 PE：身份证影像 extraContent；物料 PE：tabs+effects 静态面', () => {
    clearBindingsForTests()
    registerBinding(
      bindingFromResourceClient(EMPLOYEE_RESOURCE, mockClient(EMPLOYEE_RESOURCE)),
    )
    registerBinding(
      bindingFromResourceClient(MATERIAL_RESOURCE, mockClient(MATERIAL_RESOURCE)),
    )
    registerBinding(bindingFromResourceClient('basAccounts', mockClient('basAccounts')))

    const emp = createEmployeePresentation(resourceBindingFor(EMPLOYEE_RESOURCE))
    expect(emp.kind).toBe('extension')
    expect(typeof emp.extraContent).toBe('function')
    expect(emp.fields.name?.required).toBe(true)

    const mat = createMaterialPresentation(resourceBindingFor(MATERIAL_RESOURCE))
    expect(mat.kind).toBe('extension')
    expect(mat.tabs.map((t) => t.key)).toEqual(['basic', 'units'])
    expect(typeof mat.fields.isCustomerMaterial?.effects).toBe('function')

    const acc = createAccountPresentation(resourceBindingFor('basAccounts'))
    expect(acc.kind).toBe('extension')
    expect(typeof acc.fields.isGroup?.effects).toBe('function')
    expect(typeof acc.fields.role?.visible).toBe('function')
  })

  test('客户 Catalog 投影 form.kind=extension 且无脚本字段', () => {
    const doc = extensionDoc(CUSTOMER_RESOURCE, '客户')
    expect(doc.form).toEqual({ kind: 'extension' })
    for (const key of Object.keys(doc.form as object)) {
      expect(key).toBe('kind')
    }
  })

  test('销售发货 binding：拥有 AggregateDraftAdapter，表单不暴露 RecordWriter create/update', () => {
    clearBindingsForTests()
    const client = mockClient('salDeliveries')
    // 与 registry 一致：无 create/update writer，挂 draft
    const base = bindingFromResourceClient('salDeliveries', client, {
      canCreate: false,
      canUpdate: false,
      canDelete: true,
    })
    const draft: AggregateDraftAdapter<Record<string, unknown>, {
      id: string
      items: Array<{ id: string; idx: number }>
      packBoxes: unknown[]
    }> = {
      loadDraft: async (id) => ({
        id,
        items: Array.from({ length: 250 }, (_, i) => ({ id: `i${i}`, idx: i + 1 })),
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
    registerBinding({ ...base, draft })

    const binding = resourceBindingFor('salDeliveries')
    expect(binding.draft).toBeDefined()
    expect(binding.writer && 'create' in binding.writer && (binding.writer as { create?: unknown }).create).toBeFalsy()
    expect(binding.writer && 'update' in binding.writer && (binding.writer as { update?: unknown }).update).toBeFalsy()
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
    clearBindingsForTests()
    const binding: ResourceBinding = {
      ...bindingFromResourceClient(CUSTOMER_RESOURCE, mockClient(CUSTOMER_RESOURCE)),
    }
    registerBinding(binding)
    const pe = createCustomerPresentation(resourceBindingFor(CUSTOMER_RESOURCE))

    // Catalog 文档无 transport
    const catalog = extensionDoc(CUSTOMER_RESOURCE, '客户')
    expect('draft' in catalog).toBe(false)
    expect('writer' in catalog).toBe(false)
    expect('reader' in catalog).toBe(false)

    // PE 持 binding 引用，不自建 client
    expect(pe.binding.resource).toBe(CUSTOMER_RESOURCE)
    expect(pe.binding.reader).toBeDefined()

    // Adapter 是 transport，不是 Meta
    expect(salesDeliveryDraftAdapter).not.toHaveProperty('form')
    expect(salesDeliveryDraftAdapter).not.toHaveProperty('schemaVersion')

    // replaceBinding 可覆盖 draft 而不改 Catalog
    replaceBinding({
      ...resourceBindingFor(CUSTOMER_RESOURCE),
      draft: undefined,
    })
    expect(resourceBindingFor(CUSTOMER_RESOURCE).draft).toBeUndefined()
  })
})
