import { describe, expect, test } from 'bun:test'
import type { ConvexReactClient } from 'convex/react'
import { createConvexBindingResolver } from './convex-bindings'
import { CONVEX_DOMAIN_MANIFEST } from './convex-domain-manifest'

function fakeClient() {
  const calls: Array<{ kind: 'query' | 'mutation'; args: unknown }> = []
  const client = {
    async query(_reference: unknown, args: unknown) {
      calls.push({ kind: 'query', args })
      return { id: 'loaded-1', items: [] }
    },
    async mutation(_reference: unknown, args: unknown) {
      calls.push({ kind: 'mutation', args })
      return { id: 'saved-1', items: [] }
    },
  } as unknown as ConvexReactClient
  return { client, calls }
}

const manifestAggregateResources = Object.entries(CONVEX_DOMAIN_MANIFEST)
  .filter(([, manifest]) => manifest.aggregate)
  .map(([resource]) => resource)
  .sort()

describe('Convex 聚合 Draft 真实 binding 装配', () => {
  test('全部 manifest aggregate 的真实 binding 不暴露普通创建/更新', () => {
    const { client } = fakeClient()
    const resolve = createConvexBindingResolver(client)

    for (const resource of manifestAggregateResources) {
      const binding = resolve(resource)
      expect(typeof binding.draft?.loadDraft, `${resource}.draft.load`).toBe('function')
      expect(typeof binding.draft?.createDraft, `${resource}.draft.create`).toBe('function')
      expect(typeof binding.draft?.replaceDraft, `${resource}.draft.replace`).toBe('function')
      expect(binding.writer?.create, `${resource}.writer.create`).toBeUndefined()
      expect(binding.writer?.update, `${resource}.writer.update`).toBeUndefined()
      expect(typeof binding.writer?.delete, `${resource}.writer.delete`).toBe('function')
    }
  })

  test('应用壳原地装配后每张聚合草稿只发一次 mutation，删除走 removeDraft', async () => {
    // activateConvexResourceBindings 会按产品设计原地改写模块级 Adapter；放到子进程
    // 验证，避免该真实装配动作污染同一 bun test worker 中的其他 registry 契约测试。
    const fixture = `${import.meta.dir}/aggregate-draft-runtime.fixture.ts`
    const child = Bun.spawn([process.execPath, fixture], {
      cwd: process.cwd(),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(exitCode, stderr).toBe(0)
    expect(JSON.parse(stdout)).toEqual({
      resources: manifestAggregateResources,
      createMutations: manifestAggregateResources.length,
      deleteMutations: manifestAggregateResources.length,
    })
  })
})
