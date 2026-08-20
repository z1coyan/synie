/**
 * 授权声明的内省断言（工单 03）：
 * 全资源有声明、形态自洽、global 无公司列、via 闭包、supportedScopes 投影。
 */
import type { DataScope } from '@synie/shared'
import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_OWNER_COLUMN,
  DEFAULT_STAMPED_DEPT_COLUMN,
  assertValidAuthzDeclaration,
  resolveAuthzBinding,
  supportedScopesOf,
} from './resource-authz.ts'
import { createSealedResourceRegistry } from './register-all.ts'
import type { ResourceMeta } from './types.ts'

const registry = createSealedResourceRegistry()
const all = registry.list()

function metaOf(name: string): ResourceMeta {
  const meta = registry.get(name)
  if (!meta) throw new Error(`未注册资源: ${name}`)
  return meta
}

describe('authz 声明覆盖', () => {
  test('目录内全部资源都有 authz 声明', () => {
    const missing = all.filter((m) => !m.authz).map((m) => m.name)
    expect(missing).toEqual([])
  })

  test('形态分布快照（防止归类漂移；新增资源需有意识更新本断言）', () => {
    const counts = { company: 0, global: 0, via: 0 }
    for (const meta of all) counts[meta.authz!.kind] += 1
    expect(counts).toEqual({ company: 38, global: 37, via: 39 })
    expect(counts.company + counts.global + counts.via).toBe(all.length)
  })

  test('global 资源确无 company_id 列（漏声明防呆）', () => {
    for (const meta of all) {
      if (meta.authz!.kind !== 'global') continue
      expect(meta.fields.some((f) => f.dbColumn === 'company_id')).toBe(false)
    }
  })

  test('via 资源的宿主在目录内且外键列存在', () => {
    for (const meta of all) {
      const authz = meta.authz!
      if (authz.kind !== 'via') continue
      expect(registry.get(authz.parent)).toBeDefined()
      expect(meta.fields.some((f) => f.dbColumn === authz.fk)).toBe(true)
    }
  })

  test('readAnyOf 只用于无独立权限点的投影/重载，且码在目录内', () => {
    const codes = new Set(registry.allPermissionCodes())
    const withAnyOf = all.filter((m) => (m.authz!.readAnyOf ?? []).length > 0).map((m) => m.name)
    expect(withAnyOf.sort()).toEqual([
      'accBankImports',
      'hrAttendanceImports',
      'scmOrderFlowItems',
    ])
    for (const name of withAnyOf) {
      for (const code of metaOf(name).authz!.readAnyOf!) {
        expect(codes.has(code)).toBe(true)
      }
    }
  })
})

describe('绑定解析', () => {
  test('company 形态缺省列为 company_id、缺省不可空', () => {
    const binding = resolveAuthzBinding(metaOf('salOrders'))
    expect(binding).toMatchObject({ kind: 'company', company: { column: 'company_id', nullable: false } })
  })

  test('审计日志声明公司列可空', () => {
    expect(resolveAuthzBinding(metaOf('sysAuditLogs')).company).toEqual({
      column: 'company_id',
      nullable: true,
    })
  })

  test('via 形态解析出宿主与外键，不带行级绑定', () => {
    const binding = resolveAuthzBinding(metaOf('salOrderItems'))
    expect(binding).toMatchObject({ kind: 'via', via: { parent: 'salOrders', fk: 'order_id' } })
    expect(binding.owner).toBeUndefined()
    expect(binding.dept).toBeUndefined()
  })

  test('owner 缺省列为 created_by_id，stamped 部门缺省列为 owner_dept_id', () => {
    const base = metaOf('salOrders')
    const withBindings: ResourceMeta = {
      ...base,
      authz: { kind: 'company', owner: {}, dept: { mode: 'stamped' } },
    }
    const binding = resolveAuthzBinding(withBindings)
    expect(binding.owner).toEqual({ column: DEFAULT_OWNER_COLUMN })
    expect(binding.dept).toEqual({ column: DEFAULT_STAMPED_DEPT_COLUMN, mode: 'stamped' })
  })
})

describe('声明校验 fail-closed', () => {
  const base = metaOf('salOrders')

  test('缺声明即报错并点名资源', () => {
    expect(() => assertValidAuthzDeclaration({ ...base, authz: undefined })).toThrow(/salOrders/)
  })

  test('recordGrants 第一期拒绝', () => {
    expect(() =>
      assertValidAuthzDeclaration({ ...base, authz: { kind: 'company', recordGrants: true } }),
    ).toThrow(/记录级授权第一期不实现/)
  })

  test('assigned 部门形态必须显式声明业务列', () => {
    expect(() =>
      assertValidAuthzDeclaration({ ...base, authz: { kind: 'company', dept: { mode: 'assigned' } } }),
    ).toThrow(/assigned/)
  })

  test('via 必须同时给出 parent 与 fk', () => {
    expect(() =>
      assertValidAuthzDeclaration({ ...base, authz: { kind: 'via', parent: 'salOrders', fk: '' } }),
    ).toThrow(/parent 与 fk/)
  })
})

describe('supportedScopes 投影', () => {
  test('无 owner/dept 声明的资源只支持 all', () => {
    expect(supportedScopesOf(metaOf('salOrders'))).toEqual(['all'])
    expect(supportedScopesOf(metaOf('basCurrencies'))).toEqual(['all'])
  })

  test('via 资源不拥有自己的范围（判定递归宿主）', () => {
    expect(supportedScopesOf(metaOf('salOrderItems'))).toEqual([])
  })

  test('声明 owner/dept 后开放对应范围', () => {
    const base = metaOf('salOrders')
    expect(supportedScopesOf({ ...base, authz: { kind: 'company', owner: {} } })).toEqual([
      'all',
      'self',
    ])
    expect(
      supportedScopesOf({
        ...base,
        authz: { kind: 'company', owner: {}, dept: { mode: 'stamped' } },
      }),
    ).toEqual(['all', 'deptTree', 'dept', 'self'])
  })

  test('权限目录携带 supportedScopes；声明了 owner/dept 的前缀才多出 self / dept 维度', () => {
    // sys.file 绑 owner=上传者；mfg.demand 指派部门、mfg.work_order 归属部门（工单 07 试点）
    const expected: Record<string, DataScope[]> = {
      'sys.file': ['all', 'self'],
      'mfg.demand': ['all', 'deptTree', 'dept'],
      'mfg.work_order': ['all', 'deptTree', 'dept'],
    }
    const groups = registry.permissionCatalog()
    expect(groups.length).toBeGreaterThan(0)
    for (const group of groups) {
      expect(group.supportedScopes).toEqual(expected[group.prefix] ?? ['all'])
    }
  })

  test('assigned/stamped 两形态都开放 dept 维度，绑定列各归各的声明', () => {
    expect(resolveAuthzBinding(metaOf('mfgDemands')).dept).toEqual({
      column: 'assigned_dept_id',
      mode: 'assigned',
    })
    expect(resolveAuthzBinding(metaOf('mfgWorkOrders')).dept).toEqual({
      column: DEFAULT_STAMPED_DEPT_COLUMN,
      mode: 'stamped',
    })
    // 子行按 via 递归宿主，自身不拥有范围（否则同前缀交集会把 dept 交没）
    expect(supportedScopesOf(metaOf('mfgDemandItems'))).toEqual([])
  })

  test('库存三单据与分录只出 all（无 owner/dept 绑定，矩阵不得授出行级范围）', () => {
    for (const name of ['invStockDocs', 'invStockTransfers', 'invStockCounts', 'invStockEntries']) {
      expect([name, supportedScopesOf(metaOf(name))]).toEqual([name, ['all']])
      const binding = resolveAuthzBinding(metaOf(name))
      expect([name, binding.owner, binding.dept]).toEqual([name, undefined, undefined])
    }
    // 单据行随母单（via），自身不拥有范围
    for (const name of ['invStockDocItems', 'invStockTransferItems', 'invStockCountItems']) {
      expect([name, supportedScopesOf(metaOf(name))]).toEqual([name, []])
    }
  })

  test('主数据（物料/分类/工序/工艺模板/BOM/模具）是 global，矩阵不得授出行级范围', () => {
    for (const name of [
      'invMaterialCategories',
      'invMaterials',
      'mfgOperations',
      'mfgProcessTemplates',
      'mfgBoms',
      'mfgMoldDesigns',
    ]) {
      const binding = resolveAuthzBinding(metaOf(name))
      expect([name, binding.kind]).toEqual([name, 'global'])
      expect([name, supportedScopesOf(metaOf(name))]).toEqual([name, ['all']])
    }
    // 仓库是本批唯一公司域主数据（无 owner/dept 绑定，同样只出 all）
    expect(resolveAuthzBinding(metaOf('invWarehouses')).company).toEqual({
      column: 'company_id',
      nullable: false,
    })
    expect(supportedScopesOf(metaOf('invWarehouses'))).toEqual(['all'])
    // 单位转换与 BOM/模板子行随归宿（via），自身不拥有范围
    for (const name of [
      'invMaterialUnits',
      'mfgProcessTemplateItems',
      'mfgBomComponents',
      'mfgBomRoutes',
      'mfgBomByproducts',
    ]) {
      expect([name, supportedScopesOf(metaOf(name))]).toEqual([name, []])
    }
  })

  test('via 的挂接资源与文件同前缀，不新增权限码', () => {
    const codes = registry.allPermissionCodes().filter((c) => c.startsWith('sys.file:'))
    expect(codes).toEqual(['sys.file:create', 'sys.file:delete', 'sys.file:read'])
  })

  test('声明 readAnyOf 的资源不进权限目录（无独立权限点）', () => {
    const prefixes = new Set(registry.permissionCatalog().map((g) => g.prefix))
    expect(prefixes.has(metaOf('scmOrderFlowItems').permissionPrefix)).toBe(false)
    // 同前缀的主资源仍在目录内
    expect(prefixes.has('hr.attendance_punch')).toBe(true)
  })
})
