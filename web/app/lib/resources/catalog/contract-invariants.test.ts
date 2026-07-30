/**
 * contract 静态约束：阻止重新引入 legacy 路径。
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { listRemoteDefaultKeys } from '~/components/synie-remote-select/remote-query'
import { drawerConfig } from '~/components/synie-record-drawer/extension-drawer-props'

const repoRoot = join(import.meta.dir, '../../../../../')

function read(rel: string): string {
  return readFileSync(join(repoRoot, rel), 'utf8')
}

describe('Resource Catalog contract 不变量', () => {
  test('无 legacy-normalize 模块', () => {
    expect(existsSync(join(repoRoot, 'server/src/platform/meta/legacy-normalize.ts'))).toBe(false)
  })

  test('无 v1 gridMeta 从 envelope 派生的 meta.ts', () => {
    expect(existsSync(join(repoRoot, 'web/app/lib/resources/meta.ts'))).toBe(false)
  })

  test('无全局 drawer registry 文件', () => {
    expect(existsSync(join(repoRoot, 'web/app/components/synie-record-drawer/registry.tsx'))).toBe(
      false,
    )
  })

  test('shared ResourceMetaDocument 即为 ResourceDocument', () => {
    const meta = read('packages/shared/src/meta.ts')
    expect(meta).toMatch(/export type ResourceMetaDocument = ResourceDocument/)
    expect(meta).not.toMatch(/grid:\s*GridMeta/)
  })

  test('useGridMeta 从 Catalog 派生且不依赖 ResourceClient', () => {
    const src = read('web/app/components/synie-data-grid/meta.ts')
    expect(src).toContain('fetchResourceDocument')
    expect(src).toContain('gridMetaFromDocument')
    expect(src).not.toContain('ResourceClient')
    expect(src).not.toContain('resourceClientFor')
  })

  test('remote defaults 列表为空', () => {
    expect(listRemoteDefaultKeys()).toEqual([])
  })

  test('extension drawer props 未知资源 fail-closed', () => {
    expect(() => drawerConfig('__no_such_resource__')).toThrow()
  })
})
