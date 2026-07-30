import { describe, expect, test } from 'bun:test'
import {
  decodeResourceDocument,
  ResourceDocumentDecodeError,
} from './resource-document-decode.ts'
import {
  RESOURCE_DOCUMENT_SCHEMA_VERSION,
  type ResourceDocument,
} from './resource-document.ts'

function currencyDocument(overrides: Partial<ResourceDocument> = {}): ResourceDocument {
  const base: ResourceDocument = {
    schemaVersion: RESOURCE_DOCUMENT_SCHEMA_VERSION,
    name: 'basCurrencies',
    label: '货币',
    permissionPrefix: 'base.currency',
    capabilities: ['create', 'update', 'delete'],
    fields: [
      {
        kind: 'uuid',
        name: 'id',
        label: 'id',
        visibility: 'readable',
        input: { create: 'forbidden', update: 'forbidden' },
        filterable: false,
        sortable: true,
      },
      {
        kind: 'scalar',
        scalarType: 'string',
        name: 'name',
        label: '货币名称',
        visibility: 'readable',
        input: { create: 'required', update: 'allowed' },
        filterable: true,
        sortable: true,
        searchable: true,
      },
      {
        kind: 'scalar',
        scalarType: 'string',
        name: 'isoCode',
        label: 'ISO 编码',
        visibility: 'readable',
        input: { create: 'required', update: 'forbidden' },
        filterable: true,
        sortable: true,
      },
      {
        kind: 'scalar',
        scalarType: 'string',
        name: 'symbol',
        label: '符号',
        visibility: 'readable',
        input: { create: 'optional', update: 'allowed', clearable: true },
        filterable: true,
        sortable: true,
      },
      {
        kind: 'scalar',
        scalarType: 'boolean',
        name: 'active',
        label: '启用',
        visibility: 'readable',
        input: { create: 'optional', update: 'allowed', initial: true },
        filterable: true,
        sortable: true,
      },
    ],
    lookup: {
      labelField: 'name',
      searchFields: ['name', 'isoCode'],
      defaultSort: { column: 'isoCode', direction: 'ascending' },
    },
    list: { columns: ['name', 'isoCode', 'symbol', 'active'] },
    form: {
      kind: 'basic',
      layout: {
        fields: [
          { field: 'name', span: 6, placeholder: '如 人民币' },
          { field: 'isoCode', span: 6, placeholder: '三位大写字母,如 CNY' },
          { field: 'symbol', span: 6, placeholder: '如 ¥' },
        ],
      },
    },
    commands: [],
  }
  return { ...base, ...overrides }
}

describe('ResourceDocument v2 契约', () => {
  test('合法币种文档通过 decoder', () => {
    const doc = decodeResourceDocument(currencyDocument())
    expect(doc.schemaVersion).toBe(2)
    expect(doc.label).toBe('货币')
    expect(doc.form.kind).toBe('basic')
    expect(doc.fields.find((f) => f.name === 'isoCode')?.input).toEqual({
      create: 'required',
      update: 'forbidden',
    })
  })

  test('覆盖全部字段 kind 与 form/command 形态', () => {
    const doc = decodeResourceDocument({
      schemaVersion: 2,
      name: 'demo',
      label: '演示',
      permissionPrefix: 'demo.x',
      capabilities: ['update', 'reconcile'],
      fields: [
        {
          kind: 'scalar',
          scalarType: 'decimal',
          name: 'amount',
          label: '金额',
          visibility: 'readable',
          input: { create: 'required', update: 'allowed' },
          filterable: true,
          sortable: true,
          decimalScale: 2,
        },
        {
          kind: 'json',
          name: 'payload',
          label: '载荷',
          visibility: 'readable',
          input: { create: 'optional', update: 'allowed' },
          filterable: false,
          sortable: false,
        },
        {
          kind: 'enum',
          name: 'status',
          label: '状态',
          visibility: 'readable',
          input: { create: 'required', update: 'allowed' },
          filterable: true,
          sortable: true,
          options: [{ value: 'open', label: '打开' }],
        },
        {
          kind: 'enumArray',
          name: 'tags',
          label: '标签',
          visibility: 'readable',
          input: { create: 'optional', update: 'allowed' },
          filterable: true,
          sortable: false,
          options: [{ value: 'a', label: 'A' }],
        },
        {
          kind: 'reference',
          name: 'currencyId',
          label: '币种',
          visibility: 'readable',
          input: { create: 'required', update: 'allowed' },
          filterable: true,
          sortable: true,
          targetResource: 'basCurrencies',
          relation: 'currency',
          filterState: { active: { kind: 'bool', eq: true } },
        },
        {
          kind: 'polymorphicReference',
          name: 'partyId',
          label: '对手',
          visibility: 'readable',
          input: { create: 'optional', update: 'allowed' },
          filterable: true,
          sortable: false,
          discriminator: 'partyType',
          discriminatorType: 'enum',
          variants: [
            {
              value: 'COMPANY',
              resource: 'basCompanies',
              labelField: 'name',
              label: '内部公司',
            },
          ],
        },
        {
          kind: 'scalar',
          scalarType: 'string',
          name: 'secret',
          label: '密钥',
          visibility: 'writeOnly',
          input: { create: 'optional', update: 'allowed' },
          filterable: false,
          sortable: false,
        },
        {
          kind: 'uuid',
          name: 'id',
          label: 'id',
          visibility: 'readable',
          input: { create: 'forbidden', update: 'forbidden' },
          filterable: false,
          sortable: true,
        },
      ],
      lookup: { labelField: 'status', searchFields: ['status'] },
      list: { columns: ['status', 'amount'] },
      form: { kind: 'extension' },
      commands: [
        {
          key: 'reconcile',
          label: '对账',
          target: 'rowOrBulk',
          requiredCapability: 'reconcile',
        },
        {
          key: 'recalc',
          label: '重算',
          target: 'collection',
          requiredCapability: 'recalc',
        },
        {
          key: 'setDefault',
          label: '设为默认',
          target: 'row',
          requiredCapability: 'update',
        },
        {
          key: 'batchTag',
          label: '批量标记',
          target: 'bulk',
          requiredCapability: 'update',
        },
      ],
    })
    expect(doc.fields.map((f) => f.kind).sort()).toEqual([
      'enum',
      'enumArray',
      'json',
      'polymorphicReference',
      'reference',
      'scalar',
      'scalar',
      'uuid',
    ])
    expect(doc.form.kind).toBe('extension')
    expect(doc.commands.map((c) => c.target).sort()).toEqual([
      'bulk',
      'collection',
      'row',
      'rowOrBulk',
    ])
    expect(doc.fields.find((f) => f.name === 'secret')?.visibility).toBe('writeOnly')
  })

  test('form.kind=none 合法', () => {
    const doc = decodeResourceDocument(
      currencyDocument({ form: { kind: 'none' }, fields: currencyDocument().fields }),
    )
    expect(doc.form.kind).toBe('none')
  })

  test('拒绝未知 schema version', () => {
    expect(() =>
      decodeResourceDocument({ ...currencyDocument(), schemaVersion: 1 }),
    ).toThrow(ResourceDocumentDecodeError)
    expect(() =>
      decodeResourceDocument({ ...currencyDocument(), schemaVersion: 99 }),
    ).toThrow(/schema version/)
  })

  test('拒绝非法字段 kind', () => {
    const raw = currencyDocument() as unknown as Record<string, unknown>
    const fields = [...(raw.fields as unknown[])]
    fields[1] = { ...(fields[1] as object), kind: 'text' }
    expect(() => decodeResourceDocument({ ...raw, fields })).toThrow(/未知字段 kind/)
  })

  test('拒绝断裂布局引用与重复字段', () => {
    expect(() =>
      decodeResourceDocument(
        currencyDocument({
          form: {
            kind: 'basic',
            layout: { fields: [{ field: 'notAField' }] },
          },
        }),
      ),
    ).toThrow(/未知字段/)

    expect(() =>
      decodeResourceDocument(
        currencyDocument({
          form: {
            kind: 'basic',
            layout: {
              fields: [
                { field: 'name' },
                { field: 'isoCode' },
                { field: 'name' },
              ],
            },
          },
        }),
      ),
    ).toThrow(/重复引用/)
  })

  test('拒绝 create-required 字段不在 create 布局', () => {
    expect(() =>
      decodeResourceDocument(
        currencyDocument({
          form: {
            kind: 'basic',
            layout: {
              fields: [
                { field: 'name', showIn: ['edit', 'view'] },
                { field: 'isoCode' },
                { field: 'symbol' },
              ],
            },
          },
        }),
      ),
    ).toThrow(/create-required/)
  })

  test('拒绝非法 command target 与 transport 字段', () => {
    expect(() =>
      decodeResourceDocument(
        currencyDocument({
          commands: [
            {
              key: 'x',
              label: 'X',
              target: 'all' as 'row',
              requiredCapability: 'update',
            },
          ],
        }),
      ),
    ).toThrow(/非法 command target/)

    expect(() =>
      decodeResourceDocument({
        ...currencyDocument(),
        commands: [
          {
            key: 'setDefault',
            label: '设为默认',
            target: 'row',
            requiredCapability: 'update',
            http: { method: 'POST', path: '/x' },
          },
        ],
      }),
    ).toThrow(/transport/)
  })

  test('拒绝 lookup/list 引用未知字段', () => {
    expect(() =>
      decodeResourceDocument(
        currencyDocument({
          lookup: { labelField: 'missing', searchFields: ['name'] },
        }),
      ),
    ).toThrow(/labelField/)

    expect(() =>
      decodeResourceDocument(
        currencyDocument({
          list: { columns: ['name', 'ghost'] },
        }),
      ),
    ).toThrow(/列表引用未知字段/)
  })
})
