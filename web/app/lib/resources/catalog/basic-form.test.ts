import { describe, expect, test } from 'bun:test'
import type { ResourceDocument } from '@synie/shared'
import {
  basicFormDrawerProps,
  decodeCurrencyCreate,
  decodeCurrencyUpdate,
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
    expect(props.fields.active).toBeUndefined()
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
