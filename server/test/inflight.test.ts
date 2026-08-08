import { describe, expect, test } from 'bun:test'
import type { Context } from 'hono'
import { createInflightTracker } from '~/platform/http/inflight.ts'

const fakeCtx = {} as Context

describe('在途请求计数（停机排空）', () => {
  test('无在途时 drained 立即返回', async () => {
    const tracker = createInflightTracker()
    expect(tracker.count()).toBe(0)
    await tracker.drained()
  })

  test('请求结束后计数归零，drained 被唤醒', async () => {
    const tracker = createInflightTracker()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    // 模拟一个在途请求（handler 阻塞在 gate 上）
    const running = tracker.middleware(fakeCtx, async () => {
      await gate
    })
    expect(tracker.count()).toBe(1)

    let drainedResolved = false
    const drainedWait = tracker.drained().then(() => {
      drainedResolved = true
    })
    // 让微任务轮转一轮：请求未结束时 drained 不应返回
    await Promise.resolve()
    expect(drainedResolved).toBe(false)

    release()
    await running
    await drainedWait
    expect(drainedResolved).toBe(true)
    expect(tracker.count()).toBe(0)
  })

  test('handler 抛错也会回收计数', async () => {
    const tracker = createInflightTracker()
    await expect(
      tracker.middleware(fakeCtx, async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(tracker.count()).toBe(0)
  })
})
