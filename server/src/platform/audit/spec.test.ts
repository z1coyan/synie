/**
 * 审计规格派生单测 + 全量声明覆盖：
 * Registry 内所有 audit.enabled 资源必须能派生非空白名单（声明漂移/typo 启动即炸的测试面）。
 */
import { describe, expect, test } from 'bun:test'
import { registerAllResources } from '../meta/register-all.ts'
import { createRegistry } from '../meta/registry.ts'
import type { ResourceMeta } from '../meta/types.ts'
import { auditFieldsOf, auditSpecOf, mergeAuditFields, pickAuditFields } from './spec.ts'
import { customerResourceMeta, supplierResourceMeta } from '~/modules/party/meta.ts'

function fixtureMeta(overrides: Partial<ResourceMeta> = {}): ResourceMeta {
  return {
    name: 'testThings',
    permissionPrefix: 'test.thing',
    permissionLabel: '测试',
    table: 'test_thing',
    fields: [
      { name: 'id', apiName: 'id', dbColumn: 'id', type: 'uuid', label: 'id' },
      { name: 'code', apiName: 'code', dbColumn: 'code', type: 'string', label: '编码' },
      { name: 'name', apiName: 'name', dbColumn: 'name', type: 'string', label: '名称' },
      { name: 'derived', apiName: 'derived', dbColumn: 'derived', type: 'string', label: '派生', calculated: true },
      { name: 'inserted_at', apiName: 'insertedAt', dbColumn: 'inserted_at', type: 'datetime', label: '创建时间' },
      { name: 'updated_at', apiName: 'updatedAt', dbColumn: 'updated_at', type: 'datetime', label: '更新时间' },
    ],
    actions: [],
    audit: { enabled: true },
    ...overrides,
  }
}

describe('auditSpecOf', () => {
  test('派生 = 非 calculated 物理字段 − id/inserted_at/updated_at', () => {
    expect(auditFieldsOf(fixtureMeta())).toEqual(['code', 'name'])
  })

  test('exclude 显式排除；extra 追加在尾部；sensitiveFields 透传', () => {
    const spec = auditSpecOf(
      fixtureMeta({
        audit: { enabled: true, exclude: ['code'], extra: ['tag_ids'], sensitiveFields: ['secret'] },
      }),
    )
    expect(spec.fields).toEqual(['name', 'tag_ids'])
    expect(spec.metaFields).toEqual(['name'])
    expect(spec.sensitiveFields).toEqual(['secret'])
  })

  test('未声明 audit.enabled 不能派生（fail-closed）', () => {
    expect(() => auditSpecOf(fixtureMeta({ audit: undefined }))).toThrow(/未声明 audit.enabled/)
    expect(() => auditSpecOf(fixtureMeta({ audit: { enabled: false } }))).toThrow(
      /未声明 audit.enabled/,
    )
  })

  test('exclude 引用未知/非物理字段抛错', () => {
    expect(() =>
      auditSpecOf(fixtureMeta({ audit: { enabled: true, exclude: ['nope'] } })),
    ).toThrow(/audit.exclude/)
    expect(() =>
      auditSpecOf(fixtureMeta({ audit: { enabled: true, exclude: ['derived'] } })),
    ).toThrow(/audit.exclude/)
  })

  test('extra 撞物理字段抛错', () => {
    expect(() => auditSpecOf(fixtureMeta({ audit: { enabled: true, extra: ['code'] } }))).toThrow(
      /audit.extra/,
    )
  })

  test('rename 键必须在白名单内；rename 撞名抛错', () => {
    expect(auditFieldsOf(fixtureMeta(), { rename: { code: 'number' } })).toEqual([
      'number',
      'name',
    ])
    expect(() => auditFieldsOf(fixtureMeta(), { rename: { nope: 'x' } })).toThrow(/rename/)
    expect(() =>
      auditFieldsOf(fixtureMeta({ audit: { enabled: true, exclude: ['code'] } }), {
        rename: { code: 'number' },
      }),
    ).toThrow(/rename/)
    expect(() => auditFieldsOf(fixtureMeta(), { rename: { code: 'name' } })).toThrow(/重复/)
  })
})

describe('mergeAuditFields / pickAuditFields', () => {
  test('并集保序去重', () => {
    expect(mergeAuditFields(['a', 'b'], ['b', 'c'], ['a', 'd'])).toEqual(['a', 'b', 'c', 'd'])
  })

  test('子集越界抛错', () => {
    expect(pickAuditFields(['a', 'b'], ['b'])).toEqual(['b'])
    expect(() => pickAuditFields(['a', 'b'], ['c'])).toThrow(/白名单外/)
  })
})

describe('全量声明覆盖', () => {
  test('Registry 内所有 audit.enabled 资源均可派生非空白名单', () => {
    const registry = createRegistry()
    registerAllResources(registry)
    for (const meta of registry.list()) {
      if (!meta.audit?.enabled) continue
      const spec = auditSpecOf(meta)
      expect(spec.fields.length).toBeGreaterThan(0)
    }
  })

  test('客户/供应商审计白名单同构（party-service 共用一份派生）', () => {
    expect(auditFieldsOf(customerResourceMeta())).toEqual(auditFieldsOf(supplierResourceMeta()))
  })
})
