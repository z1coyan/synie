import {
  RESOURCE_DOCUMENT_SCHEMA_VERSION,
  decodeResourceDocument,
  type FieldDocument,
  type ResourceDocument,
} from '@synie/shared'
import type { Actor } from '../lib/actor'
import { hasPermission } from '../lib/permissions'
import { pilotQueryProfiles, publicQueryProfiles, sealQueryProfiles } from '../lib/queryProfiles'

const readonly = { create: 'forbidden', update: 'forbidden' } as const
const required = { create: 'required', update: 'allowed' } as const
const optional = { create: 'optional', update: 'allowed', clearable: true } as const
const defaults = (initial: unknown) => ({ create: 'optional', update: 'allowed', initial }) as const

function idField(): FieldDocument {
  // `uuid` is the v2 historical display kind. It is intentionally treated as
  // an opaque string by all adapters; no UUID syntax validation remains.
  return { name: 'id', label: 'id', kind: 'uuid', visibility: 'readable', input: readonly, filterable: false, sortable: false }
}

function scalar(
  name: string,
  label: string,
  scalarType: 'string' | 'boolean' | 'datetime' | 'decimal',
  input: FieldDocument['input'],
  options: Partial<Pick<Extract<FieldDocument, { kind: 'scalar' }>, 'filterable' | 'sortable' | 'searchable' | 'decimalScale'>> = {},
): FieldDocument {
  return {
    name, label, kind: 'scalar', scalarType, visibility: 'readable', input,
    filterable: options.filterable ?? false,
    sortable: options.sortable ?? false,
    ...(options.searchable === undefined ? {} : { searchable: options.searchable }),
    ...(options.decimalScale === undefined ? {} : { decimalScale: options.decimalScale }),
  }
}

const currencyDocument: ResourceDocument = {
  schemaVersion: RESOURCE_DOCUMENT_SCHEMA_VERSION,
  name: 'basCurrencies',
  label: '货币',
  permissionPrefix: 'base.currency',
  capabilities: ['create', 'update', 'delete'],
  fields: [
    idField(),
    scalar('name', '货币名称', 'string', required, { searchable: true }),
    scalar('isoCode', 'ISO 编码', 'string', { create: 'required', update: 'forbidden' }, { searchable: true }),
    scalar('symbol', '符号', 'string', optional),
    scalar('active', '启用', 'boolean', defaults(true), { filterable: true }),
    scalar('insertedAt', '创建时间', 'datetime', readonly),
    scalar('updatedAt', '更新时间', 'datetime', readonly),
  ],
  lookup: { labelField: 'name', searchFields: ['name', 'isoCode'], subtitleFields: ['isoCode'] },
  list: { columns: ['id', 'name', 'isoCode', 'symbol', 'active', 'insertedAt', 'updatedAt'] },
  form: { kind: 'basic', layout: { fields: [
    { field: 'name', placeholder: '如 人民币' },
    { field: 'isoCode', placeholder: '三位大写字母,如 CNY' },
    { field: 'symbol', placeholder: '如 ¥' },
  ] } },
  commands: [],
  queryProfiles: publicQueryProfiles('basCurrencies'),
}

const unitTypeOptions = [
  { value: 'LENGTH', label: '长度' },
  { value: 'AREA', label: '面积' },
  { value: 'WEIGHT', label: '重量' },
  { value: 'QUANTITY', label: '数量' },
]

const unitDocument: ResourceDocument = {
  schemaVersion: RESOURCE_DOCUMENT_SCHEMA_VERSION,
  name: 'basUnits',
  label: '单位',
  permissionPrefix: 'base.unit',
  capabilities: ['create', 'update', 'delete'],
  fields: [
    idField(),
    { name: 'unitType', label: '单位类型', kind: 'enum', options: unitTypeOptions, visibility: 'readable', input: required, filterable: true, sortable: false },
    scalar('isBase', '基准单位', 'boolean', defaults(false)),
    scalar('name', '单位名称', 'string', required, { searchable: true }),
    scalar('symbol', '单位符号', 'string', required, { searchable: true }),
    scalar('ratio', '换算比例', 'decimal', { ...required, initial: '1' }, { decimalScale: 6 }),
    scalar('insertedAt', '创建时间', 'datetime', readonly),
    scalar('updatedAt', '更新时间', 'datetime', readonly),
  ],
  lookup: { labelField: 'name', searchFields: ['name', 'symbol'], subtitleFields: ['symbol'] },
  list: { columns: ['id', 'unitType', 'isBase', 'name', 'symbol', 'ratio', 'insertedAt', 'updatedAt'] },
  form: { kind: 'basic', layout: { fields: [
    { field: 'unitType' }, { field: 'isBase' },
    { field: 'name', placeholder: '如 千克', span: 6 },
    { field: 'symbol', placeholder: '如 kg', span: 6 },
    { field: 'ratio', placeholder: '换算到基准单位的比例' },
  ] } },
  commands: [],
  queryProfiles: publicQueryProfiles('basUnits'),
}

const warehouseDocument: ResourceDocument = {
  schemaVersion: RESOURCE_DOCUMENT_SCHEMA_VERSION,
  name: 'invWarehouses',
  label: '仓库',
  permissionPrefix: 'inv.warehouse',
  capabilities: ['create', 'update', 'delete'],
  fields: [
    idField(),
    scalar('name', '仓库名称', 'string', required, { searchable: true }),
    scalar('isLeaf', '叶子仓库', 'boolean', defaults(true)),
    scalar('active', '启用', 'boolean', defaults(true)),
    scalar('isOutsourced', '外协仓(货物存放在协作方处的我方仓,为是必挂协作方)', 'boolean', defaults(false)),
    {
      name: 'partyType', label: '协作方类型(供应商/内部公司;外协仓必填,非外协仓必须为空)', kind: 'enum',
      options: [{ value: 'SUPPLIER', label: '供应商' }, { value: 'COMPANY', label: '内部公司' }],
      visibility: 'readable', input: optional, filterable: false, sortable: false,
    },
    {
      name: 'partyId', label: '协作方(多态引用,随 party_type 判别;一仓绑一方)', kind: 'polymorphicReference',
      discriminator: 'partyType', discriminatorType: 'enum', targetUnavailable: true,
      variants: [
        { value: 'COMPANY', resource: 'basCompanies', labelField: 'name', label: '内部公司' },
        { value: 'SUPPLIER', resource: 'purSuppliers', labelField: 'name', label: '供应商' },
      ], visibility: 'readable', input: optional, filterable: false, sortable: false,
    },
    scalar('allowNegative', '允许负库存(库存分录审核/作废的负库存校验逐仓跳过)', 'boolean', defaults(false)),
    scalar('hasChildren', '含下级仓库', 'boolean', readonly),
    scalar('insertedAt', '创建时间', 'datetime', readonly),
    scalar('updatedAt', '更新时间', 'datetime', readonly),
    {
      name: 'companyId', label: '公司', kind: 'reference', targetResource: 'basCompanies', relation: 'company', labelField: 'name', targetUnavailable: true,
      visibility: 'readable', input: { create: 'required', update: 'forbidden' }, filterable: true, sortable: false,
    },
    {
      name: 'parentId', label: '上级仓库', kind: 'reference', targetResource: 'invWarehouses', relation: 'parent', labelField: 'name',
      visibility: 'readable', input: optional, filterable: true, sortable: false,
    },
    {
      name: 'accountId', label: '关联科目', kind: 'reference', targetResource: 'basAccounts', relation: 'account', labelField: 'name', targetUnavailable: true,
      visibility: 'readable', input: optional, filterable: false, sortable: false,
    },
  ],
  lookup: { labelField: 'name', searchFields: ['name'] },
  list: { columns: ['id', 'name', 'isLeaf', 'active', 'isOutsourced', 'partyType', 'partyId', 'allowNegative', 'hasChildren', 'insertedAt', 'updatedAt', 'companyId', 'parentId', 'accountId'] },
  form: { kind: 'basic', layout: { fields: [
    { field: 'name' }, { field: 'isLeaf' }, { field: 'isOutsourced' }, { field: 'partyType' },
    { field: 'partyId' }, { field: 'allowNegative' }, { field: 'companyId' }, { field: 'parentId' }, { field: 'accountId' },
  ] } },
  commands: [
    {
      key: 'seedDefaults',
      label: '初始化默认仓库',
      target: 'collection',
      requiredCapability: 'create',
      confirmKind: 'generic',
    },
  ],
  queryProfiles: publicQueryProfiles('invWarehouses'),
}

export const pilotResourceDocuments = {
  basCurrencies: currencyDocument,
  basUnits: unitDocument,
  invWarehouses: warehouseDocument,
} as const satisfies Record<string, ResourceDocument>

export type PilotResourceName = keyof typeof pilotResourceDocuments

export function sealPilotCatalog(documents: Record<string, ResourceDocument> = pilotResourceDocuments): void {
  const known = new Set(Object.keys(documents))
  for (const [name, raw] of Object.entries(documents)) {
    const document = decodeResourceDocument(raw)
    if (document.name !== name) throw new Error(`${name}: map key 与 document.name 不一致`)
    if (!document.queryProfiles?.length) throw new Error(`${name}: Convex resource 未声明 queryProfiles`)
    if (name in pilotQueryProfiles) {
      sealQueryProfiles(name as PilotResourceName)
      const expected = pilotQueryProfiles[name as PilotResourceName].map((profile) => profile.key)
      const actual = document.queryProfiles.map((profile) => profile.key)
      if (expected.join('\0') !== actual.join('\0')) throw new Error(`${name}: Catalog/profile registry 不一致`)
    }
    for (const field of document.fields) {
      if (field.kind === 'reference' && !known.has(field.targetResource) && field.targetUnavailable !== true) {
        throw new Error(`${name}.${field.name}: 未知引用 ${field.targetResource}`)
      }
      if (field.kind === 'polymorphicReference') {
        for (const variant of field.variants) {
          if (!known.has(variant.resource) && field.targetUnavailable !== true) {
            throw new Error(`${name}.${field.name}: 未知引用 ${variant.resource}`)
          }
        }
      }
    }
    for (const command of document.commands) {
      if (!document.capabilities.includes(command.requiredCapability)) {
        throw new Error(`${name}.${command.key}: command capability 未声明`)
      }
    }
  }
}

sealPilotCatalog()

export function projectPilotResource(name: PilotResourceName, actor: Actor): ResourceDocument {
  const document = pilotResourceDocuments[name]
  return {
    ...document,
    capabilities: document.capabilities.filter((capability) =>
      hasPermission(actor, `${document.permissionPrefix}:${capability}`),
    ),
    commands: document.commands.filter((command) =>
      hasPermission(actor, `${document.permissionPrefix}:${command.requiredCapability}`),
    ),
  }
}
