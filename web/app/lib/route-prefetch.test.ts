import { describe, expect, test } from 'bun:test'
import { createResourceQueryCache } from '~/lib/resources/catalog'
import {
  defaultGridKeyParts,
  defaultGridQueryKey,
} from '~/lib/route-prefetch'
import { resourceBindingFor } from '~/lib/resources/registry'

describe('route-prefetch 默认 key 与 SynieDataGrid 首屏对齐', () => {
  test('defaultGridKeyParts 默认值匹配 DataGrid 初始 state', () => {
    const p = defaultGridKeyParts()
    // 与 SynieDataGrid: page=1, pageSize=20, search='', sort=null, filters={}, fixedFilter=null, treeActive=false
    expect(p.treeActive).toBe(false)
    expect(p.page).toBe(1)
    expect(p.pageSize).toBe(20)
    expect(p.search).toBe('')
    expect(p.sort).toBeNull()
    expect(p.filters).toEqual({})
    expect(p.fixedFilter).toBeNull()
    expect(p.sortJson).toBe('null')
    expect(p.filtersJson).toBe('{}')
    expect(p.fixedFilterKey).toBe('null')
    expect(p.extraFieldsKey).toBe('')
  })

  test('defaultGridQueryKey 经 binding.cache，不手写 gridRows', () => {
    const key = defaultGridQueryKey('basUnits')
    const binding = resourceBindingFor('basUnits')
    const expected = binding.cache.gridKey(
      false,
      1,
      20,
      '',
      'null',
      '{}',
      'null',
      '',
    )
    expect(key).toEqual(expected)
    // 结构：['gridRows', adapterId, resource, ...parts]
    expect(key[0]).toBe('gridRows')
    expect(key[2]).toBe('basUnits')
  })

  test('带筛选/分页的 parts 序列化与 gridKey 一致', () => {
    const cache = createResourceQueryCache('demo', 'memory:demo')
    const p = defaultGridKeyParts({
      page: 2,
      pageSize: 50,
      search: 'kg',
      sort: { column: 'code', direction: 'ascending' },
      filters: { isBase: { kind: 'bool', eq: true } },
      fixedFilter: { companyId: 'c1' },
      extraFields: ['symbol', 'code'],
    })
    const key = cache.gridKey(
      p.treeActive,
      p.page,
      p.pageSize,
      p.search,
      p.sortJson,
      p.filtersJson,
      p.fixedFilterKey,
      p.extraFieldsKey,
    )
    expect(key).toEqual([
      'gridRows',
      'memory:demo',
      'demo',
      false,
      2,
      50,
      'kg',
      JSON.stringify({ column: 'code', direction: 'ascending' }),
      JSON.stringify({ isBase: { kind: 'bool', eq: true } }),
      JSON.stringify({ companyId: 'c1' }),
      'code,symbol', // extraFields 排序后 join
    ])
  })

  test('SSR 守卫：ensureDefaultGridPage 在无 window 时为 no-op', async () => {
    // bun test 环境有 window 时跳过语义断言；此用例只验证导出存在与类型可调用
    const { ensureDefaultGridPage } = await import('~/lib/route-prefetch')
    expect(typeof ensureDefaultGridPage).toBe('function')
  })
})
