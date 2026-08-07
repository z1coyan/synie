/**
 * filterbuild 枚举库内大小写回归（material_type 筛选全空事故）：
 * wire 枚举恒为大写 token，库内缺省小写、`enumStorage: 'upper'` 列存大写——
 * 筛选编译曾无条件 toLowerCase，导致大写存储列（inv_material.material_type）
 * 任何枚举筛选都匹配 0 行（物料类型筛选、购销单据物料下拉全空）。
 *
 * 防复发：全目录不变量测试遍历 sealed Registry 的每个可筛选枚举字段，
 * 逐枚举值断言「筛选编译参数 ≡ 写路径 toDbValue」——两路若再各自分叉，当场失败。
 */
import { describe, expect, test } from 'bun:test'
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely'
import type { ListQuery } from '@synie/shared'
import { buildListQuery } from './filterbuild.ts'
import { createSealedResourceRegistry } from '~/platform/meta/register-all.ts'
import { toReadSpec, type ResourceReadSpec } from '~/platform/meta/read-spec.ts'
import { toDbValue } from '~/platform/standard/fields.ts'
import type { FieldMeta, ResourceMeta } from '~/platform/meta/types.ts'

const dummyDb = new Kysely<never>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new PostgresIntrospector(db),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
})

function compileWhere(spec: ResourceReadSpec, query: ListQuery) {
  const built = buildListQuery(spec, query)
  if (!built.where) throw new Error('预期产生 WHERE 条件')
  return dummyDb
    .selectFrom('x' as never)
    .selectAll()
    .where(built.where as never)
    .compile()
}

function syntheticMeta(fields: FieldMeta[]): ResourceMeta {
  return {
    name: 'synthetic',
    classification: { presentation: 'none', interactive: false },
    permissionPrefix: 'test.synthetic',
    permissionLabel: '合成',
    table: 'synthetic',
    authz: { kind: 'global' },
    fields,
    actions: [],
  }
}

function enumField(opts: Partial<FieldMeta> = {}): FieldMeta {
  return {
    name: 'material_type',
    apiName: 'materialType',
    dbColumn: 'material_type',
    type: 'enum',
    label: '物料类型',
    filterable: true,
    enumOptions: [
      { value: 'STOCK', label: '库存' },
      { value: 'VIRTUAL', label: '虚拟' },
    ],
    ...opts,
  }
}

const UUID = '123e4567-e89b-42d3-a456-426614174000'

describe('filterbuild 枚举库内大小写', () => {
  test("enumStorage: 'upper' 列：筛选值按大写存储编译（material_type 回归）", () => {
    const compiled = compileWhere(toReadSpec(syntheticMeta([enumField({ enumStorage: 'upper' })])), {
      limit: 20,
      offset: 0,
      filter: { materialType: { kind: 'enum', values: ['STOCK', 'VIRTUAL'] } },
    })
    expect(compiled.parameters[0]).toEqual(['STOCK', 'VIRTUAL'])
  })

  test('缺省（小写存储）列：筛选值按小写编译', () => {
    const compiled = compileWhere(toReadSpec(syntheticMeta([enumField()])), {
      limit: 20,
      offset: 0,
      filter: { materialType: { kind: 'enum', values: ['STOCK'] } },
    })
    expect(compiled.parameters[0]).toEqual(['stock'])
  })

  test("enumArray 列同样随 enumStorage 换算", () => {
    const field = enumField({ type: 'enumArray', enumStorage: 'upper' })
    const compiled = compileWhere(toReadSpec(syntheticMeta([field])), {
      limit: 20,
      offset: 0,
      filter: { materialType: { kind: 'enumArray', op: 'hasAny', values: ['STOCK'] } },
    })
    expect(compiled.parameters[0]).toEqual(['STOCK'])
  })

  test('多态 fk 判别值随判别字段 enumStorage 换算（缺省小写）', () => {
    const fields: FieldMeta[] = [
      enumField({ name: 'party_type', apiName: 'partyType', dbColumn: 'party_type' }),
      {
        name: 'party_id',
        apiName: 'partyId',
        dbColumn: 'party_id',
        type: 'fk',
        label: '对手',
        filterable: true,
        ref: {
          resource: null,
          relation: null,
          labelField: null,
          discriminator: 'partyType',
          discriminatorType: 'enum',
          variants: [{ value: 'CUSTOMER', resource: 'salCustomers', labelField: 'name', label: '客户' }],
        },
      },
    ]
    const compiled = compileWhere(toReadSpec(syntheticMeta(fields)), {
      limit: 20,
      offset: 0,
      filter: {
        partyId: { kind: 'polyFk', op: 'in', variant: 'CUSTOMER', values: [UUID], labels: [] },
      },
    })
    expect(compiled.parameters[0]).toBe('customer')
    expect(compiled.parameters[1]).toEqual([UUID])
  })

  test('未知枚举值仍 400（大小写换算不改变白名单校验）', () => {
    expect(() =>
      compileWhere(toReadSpec(syntheticMeta([enumField({ enumStorage: 'upper' })])), {
        limit: 20,
        offset: 0,
        filter: { materialType: { kind: 'enum', values: ['stock'] } },
      }),
    ).toThrow(/筛选条件错误/)
  })
})

describe('全目录不变量：筛选编译与写路径的枚举大小写一致', () => {
  const registry = createSealedResourceRegistry()

  test('每个可筛选枚举字段的每个枚举值：筛选参数 ≡ toDbValue', () => {
    let checked = 0
    for (const resource of registry.list()) {
      const spec = toReadSpec(resource)
      const specFields = new Map(spec.fields.map((f) => [f.apiName, f]))
      for (const field of resource.fields) {
        if (field.type !== 'enum' && field.type !== 'enumArray') continue
        if (!field.filterable) continue
        // printOnly/sensitive 不进 ReadSpec，无从筛选，不在本不变量射程内
        if (!specFields.has(field.apiName)) continue
        for (const option of field.enumOptions ?? []) {
          const filter =
            field.type === 'enum'
              ? { kind: 'enum' as const, values: [option.value] }
              : { kind: 'enumArray' as const, op: 'hasAny' as const, values: [option.value] }
          const compiled = compileWhere(spec, {
            limit: 1,
            offset: 0,
            filter: { [field.apiName]: filter },
          })
          // enumArray 的写路径按数组换算，取单元素数组对齐
          const dbValue =
            field.type === 'enumArray'
              ? (toDbValue(field, [option.value]) as string[])[0]
              : toDbValue(field, option.value)
          expect(
            compiled.parameters[0],
            `${resource.name}.${field.apiName} 筛选参数应等于写路径落库值`,
          ).toEqual([dbValue])
          checked += 1
        }
      }
    }
    // 防测试静默空转（目录里枚举字段不会少于此量级）
    expect(checked).toBeGreaterThan(50)
  })

  test("声明 enumStorage: 'upper' 的字段：筛选参数保持大写（现仅 material_type）", () => {
    const upperFields: string[] = []
    for (const resource of registry.list()) {
      for (const field of resource.fields) {
        if (field.enumStorage === 'upper') upperFields.push(`${resource.name}.${field.apiName}`)
      }
    }
    // 大写存储是历史遗留逃生舱：新增需同步评估 CHECK 约束与两条取值路径
    expect(upperFields).toEqual(['invMaterials.materialType'])
  })
})
