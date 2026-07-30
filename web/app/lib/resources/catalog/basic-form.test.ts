import { describe, expect, test } from 'bun:test'
import type { ResourceDocument } from '@synie/shared'
import {
  basicFormDrawerProps,
  decodeCurrencyCreate,
  decodeCurrencyUpdate,
  decodeUnitCreate,
  decodeUnitUpdate,
  decodeSupplierCreate,
  decodeSupplierUpdate,
  decodeCompanyCreate,
  decodeCompanyUpdate,
} from './basic-form'

function currencyDoc(): ResourceDocument {
  return {
    schemaVersion: 2,
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
    lookup: { labelField: 'name', searchFields: ['name'] },
    list: { columns: ['name', 'isoCode', 'symbol', 'active'] },
    form: {
      kind: 'basic',
      layout: {
        fields: [
          { field: 'name', placeholder: '如 人民币' },
          { field: 'isoCode', placeholder: '三位大写字母,如 CNY' },
          { field: 'symbol', placeholder: '如 ¥' },
        ],
      },
    },
    commands: [],
  }
}

function unitDoc(): ResourceDocument {
  return {
    schemaVersion: 2,
    name: 'basUnits',
    label: '单位',
    permissionPrefix: 'base.unit',
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
        kind: 'enum',
        name: 'unitType',
        label: '单位类型',
        visibility: 'readable',
        input: { create: 'required', update: 'allowed' },
        filterable: true,
        sortable: true,
        options: [
          { value: 'LENGTH', label: '长度' },
          { value: 'AREA', label: '面积' },
          { value: 'WEIGHT', label: '重量' },
          { value: 'QUANTITY', label: '数量' },
        ],
      },
      {
        kind: 'scalar',
        scalarType: 'boolean',
        name: 'isBase',
        label: '基准单位',
        visibility: 'readable',
        input: { create: 'optional', update: 'allowed' },
        filterable: true,
        sortable: true,
      },
      {
        kind: 'scalar',
        scalarType: 'string',
        name: 'name',
        label: '单位名称',
        visibility: 'readable',
        input: { create: 'required', update: 'allowed' },
        filterable: true,
        sortable: true,
      },
      {
        kind: 'scalar',
        scalarType: 'string',
        name: 'symbol',
        label: '单位符号',
        visibility: 'readable',
        input: { create: 'required', update: 'allowed' },
        filterable: true,
        sortable: true,
      },
      {
        kind: 'scalar',
        scalarType: 'decimal',
        name: 'ratio',
        label: '换算比例',
        visibility: 'readable',
        input: { create: 'required', update: 'allowed', initial: 1 },
        filterable: true,
        sortable: true,
      },
    ],
    lookup: { labelField: 'name', searchFields: ['name'] },
    list: { columns: ['unitType', 'name', 'symbol', 'ratio', 'isBase'] },
    form: {
      kind: 'basic',
      layout: {
        fields: [
          { field: 'unitType' },
          { field: 'isBase' },
          { field: 'name', placeholder: '如 千克', span: 6 },
          { field: 'symbol', placeholder: '如 kg', span: 6 },
          { field: 'ratio', placeholder: '换算到基准单位的比例' },
        ],
      },
    },
    commands: [],
  }
}

function supplierDoc(): ResourceDocument {
  return {
    schemaVersion: 2,
    name: 'purSuppliers',
    label: '供应商',
    permissionPrefix: 'purchase.supplier',
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
        name: 'code',
        label: '供应商编号',
        visibility: 'readable',
        input: { create: 'required', update: 'allowed' },
        filterable: true,
        sortable: true,
      },
      {
        kind: 'scalar',
        scalarType: 'string',
        name: 'name',
        label: '供应商名称',
        visibility: 'readable',
        input: { create: 'required', update: 'allowed' },
        filterable: true,
        sortable: true,
      },
      {
        kind: 'scalar',
        scalarType: 'string',
        name: 'shortName',
        label: '简称',
        visibility: 'readable',
        input: { create: 'optional', update: 'allowed', clearable: true },
        filterable: true,
        sortable: true,
      },
    ],
    lookup: { labelField: 'name', searchFields: ['name', 'code'] },
    list: { columns: ['code', 'name', 'shortName'] },
    form: {
      kind: 'basic',
      layout: {
        fields: [
          { field: 'code', placeholder: '如 S0001' },
          { field: 'name', placeholder: '供应商全称' },
          { field: 'shortName', placeholder: '如 富士康' },
        ],
      },
    },
    commands: [],
  }
}

function companyDoc(opts?: { currencyUnavailable?: boolean }): ResourceDocument {
  return {
    schemaVersion: 2,
    name: 'basCompanies',
    label: '公司',
    permissionPrefix: 'base.company',
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
        name: 'code',
        label: '公司编号',
        visibility: 'readable',
        input: { create: 'required', update: 'forbidden' },
        filterable: true,
        sortable: true,
      },
      {
        kind: 'scalar',
        scalarType: 'string',
        name: 'name',
        label: '公司名称',
        visibility: 'readable',
        input: { create: 'required', update: 'allowed' },
        filterable: true,
        sortable: true,
      },
      {
        kind: 'scalar',
        scalarType: 'string',
        name: 'shortName',
        label: '公司简称',
        visibility: 'readable',
        input: { create: 'required', update: 'allowed' },
        filterable: true,
        sortable: true,
      },
      {
        kind: 'reference',
        name: 'parentId',
        label: '上级公司',
        visibility: 'readable',
        input: { create: 'optional', update: 'allowed', clearable: true },
        filterable: true,
        sortable: false,
        targetResource: 'basCompanies',
        relation: 'parent',
        labelField: 'name',
      },
      {
        kind: 'reference',
        name: 'baseCurrencyId',
        label: '本币',
        visibility: 'readable',
        input: { create: 'required', update: 'allowed' },
        filterable: true,
        sortable: false,
        targetResource: 'basCurrencies',
        relation: 'baseCurrency',
        labelField: 'name',
        filterState: { active: { kind: 'bool', eq: true } },
        ...(opts?.currencyUnavailable ? { targetUnavailable: true } : {}),
      },
    ],
    lookup: { labelField: 'name', searchFields: ['name', 'code'] },
    list: { columns: ['code', 'name', 'shortName', 'baseCurrencyId', 'parentId'] },
    form: {
      kind: 'basic',
      layout: {
        fields: [
          { field: 'code', placeholder: '两位英文字母,如 SH' },
          { field: 'name', placeholder: '如 上海总部' },
          { field: 'shortName', placeholder: '如 上海' },
          { field: 'baseCurrencyId' },
          { field: 'parentId' },
        ],
      },
    },
    commands: [],
  }
}

describe('basicFormDrawerProps', () => {
  test('币种：label=货币，exclude active/id，isoCode createOnly', () => {
    const props = basicFormDrawerProps(currencyDoc())
    expect(props.label).toBe('货币')
    expect(props.exclude).toEqual(expect.arrayContaining(['id', 'active']))
    expect(props.fields.name).toMatchObject({ required: true, placeholder: '如 人民币' })
    expect(props.fields.isoCode).toMatchObject({
      required: true,
      edit: 'createOnly',
      placeholder: '三位大写字母,如 CNY',
    })
    expect(props.fields.symbol?.placeholder).toBe('如 ¥')
    expect(props.fields.name?.order).toBe(0)
    expect(props.fields.isoCode?.order).toBe(1)
    expect(props.fields.symbol?.order).toBe(2)
    expect(props.fields.active).toBeUndefined()
  })

  test('单位：enum/decimal/span/initial', () => {
    const props = basicFormDrawerProps(unitDoc())
    expect(props.label).toBe('单位')
    expect(props.fields.unitType).toMatchObject({ required: true })
    expect(props.fields.name).toMatchObject({
      required: true,
      placeholder: '如 千克',
      cols: 6,
    })
    expect(props.fields.symbol).toMatchObject({ placeholder: '如 kg', cols: 6 })
    expect(props.fields.ratio).toMatchObject({
      required: true,
      defaultValue: 1,
      placeholder: '换算到基准单位的比例',
    })
    expect(props.exclude).toEqual(expect.arrayContaining(['id']))
  })

  test('供应商：纯标量 required/placeholder', () => {
    const props = basicFormDrawerProps(supplierDoc())
    expect(props.label).toBe('供应商')
    expect(props.fields.code).toMatchObject({ required: true, placeholder: '如 S0001' })
    expect(props.fields.name).toMatchObject({ required: true, placeholder: '供应商全称' })
    expect(props.fields.shortName?.placeholder).toBe('如 富士康')
  })

  test('公司：code createOnly + 本币 filterState + 自引用外键', () => {
    const props = basicFormDrawerProps(companyDoc())
    expect(props.label).toBe('公司')
    expect(props.fields.code).toMatchObject({
      required: true,
      edit: 'createOnly',
      placeholder: '两位英文字母,如 SH',
    })
    expect(props.fields.baseCurrencyId).toMatchObject({
      required: true,
      remote: { filterState: { active: { kind: 'bool', eq: true } } },
    })
    expect(props.fields.parentId).toBeDefined()
    expect(props.fields.parentId?.remote).toBeUndefined()
  })

  test('公司：币种目标不可读 fail-closed', () => {
    expect(() => basicFormDrawerProps(companyDoc({ currencyUnavailable: true }))).toThrow(
      /目标不可读/,
    )
  })

  test('extension form fail-closed', () => {
    expect(() =>
      basicFormDrawerProps({ ...currencyDoc(), form: { kind: 'extension' } }),
    ).toThrow(/不能使用 Basic Form/)
  })

  test('json 字段布局 fail-closed', () => {
    const doc = currencyDoc()
    doc.fields.push({
      kind: 'json',
      name: 'meta',
      label: '元',
      visibility: 'readable',
      input: { create: 'optional', update: 'allowed' },
      filterable: false,
      sortable: false,
    })
    if (doc.form.kind === 'basic') {
      doc.form.layout.fields = [...(doc.form.layout.fields ?? []), { field: 'meta' }]
    }
    expect(() => basicFormDrawerProps(doc)).toThrow(/不支持字段 kind=json/)
  })
})

describe('currency codec', () => {
  test('create 解码并默认 active', () => {
    expect(decodeCurrencyCreate({ name: ' 人民币 ', isoCode: ' CNY ', symbol: '¥' })).toEqual({
      name: '人民币',
      isoCode: 'CNY',
      symbol: '¥',
      active: true,
    })
  })

  test('update 剔除 isoCode', () => {
    const input = decodeCurrencyUpdate({
      name: '人民币',
      isoCode: 'XXX',
      symbol: '',
    })
    expect(input).toEqual({ name: '人民币', symbol: null })
    expect('isoCode' in input).toBe(false)
  })
})

describe('unit codec', () => {
  test('create 解码 enum 与 ratio 字符串', () => {
    expect(
      decodeUnitCreate({
        unitType: 'weight',
        name: ' 千克 ',
        symbol: ' kg ',
        ratio: 0.001,
        isBase: false,
      }),
    ).toEqual({
      unitType: 'WEIGHT',
      name: '千克',
      symbol: 'kg',
      ratio: '0.001',
      isBase: false,
    })
  })

  test('update 支持部分字段', () => {
    expect(decodeUnitUpdate({ ratio: 1 })).toEqual({ ratio: '1' })
  })

  test('非法 unitType 拒绝', () => {
    expect(() =>
      decodeUnitCreate({ unitType: 'FOO', name: 'x', symbol: 'x', ratio: 1 }),
    ).toThrow(/单位类型/)
  })
})

describe('supplier codec', () => {
  test('create 解码纯标量', () => {
    expect(
      decodeSupplierCreate({ code: ' S1 ', name: ' 甲 ', shortName: ' 甲简称 ' }),
    ).toEqual({ code: 'S1', name: '甲', shortName: '甲简称' })
  })

  test('shortName 空串转 null', () => {
    expect(decodeSupplierCreate({ code: 'S1', name: '甲', shortName: '' })).toEqual({
      code: 'S1',
      name: '甲',
      shortName: null,
    })
  })
})

describe('company codec', () => {
  test('create 解码外键与自引用', () => {
    expect(
      decodeCompanyCreate({
        code: ' SH ',
        name: ' 上海 ',
        shortName: ' 沪 ',
        baseCurrencyId: 'cur-1',
        parentId: 'co-parent',
      }),
    ).toEqual({
      code: 'SH',
      name: '上海',
      shortName: '沪',
      baseCurrencyId: 'cur-1',
      parentId: 'co-parent',
    })
  })

  test('update 剔除 code，parentId 可空', () => {
    const input = decodeCompanyUpdate({
      code: 'XX',
      name: '新名',
      parentId: null,
    })
    expect(input).toEqual({ name: '新名', parentId: null })
    expect('code' in input).toBe(false)
  })
})
