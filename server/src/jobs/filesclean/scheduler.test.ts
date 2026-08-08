import { describe, expect, test } from 'bun:test'
import type { FileReconcileReport } from '~/platform/files/reconcile.ts'
import { createFileCleanScheduler, type FileCleanSchedulerDeps } from './scheduler.ts'

/** 2026-08-08；hour/minute 为上海墙钟 */
function shanghai(hour: number, minute: number): Date {
  return new Date(Date.UTC(2026, 7, 8, hour - 8, minute, 0))
}

function emptyReport(over: Partial<FileReconcileReport> = {}): FileReconcileReport {
  return { dryRun: true, storages: [], ...over }
}

function fakeSettings() {
  const summaries: string[] = []
  return {
    service: {
      recordFileRecon: async (_permit: unknown, summary: string) => {
        summaries.push(summary)
        return null
      },
    } as never,
    summaries,
  }
}

function deps(over: Partial<FileCleanSchedulerDeps> = {}): FileCleanSchedulerDeps {
  return {
    settings: fakeSettings().service,
    reconcile: { reconcile: async () => emptyReport() },
    enabled: true,
    dryRun: true,
    orphanGraceMs: 24 * 3600_000,
    runHour: 3,
    log: () => {},
    ...over,
  }
}

describe('createFileCleanScheduler', () => {
  test('到达每日时刻触发对账并写成功摘要', async () => {
    const settings = fakeSettings()
    const calls: Date[] = []
    const scheduler = createFileCleanScheduler(
      deps({
        settings: settings.service,
        now: () => shanghai(3, 0),
        runReconcile: async (now) => {
          calls.push(now)
          return emptyReport({
            storages: [
              {
                storage: 'local',
                error: null,
                objectCount: 10,
                dbRowCount: 8,
                orphans: ['2026/08/07/a.bin', '2026/08/07/b.bin'],
                freshOrphans: 0,
                deleted: 0,
                deleteFailed: 0,
                missing: ['2026/08/06/c.bin'],
              },
            ],
          })
        },
      }),
    )
    await scheduler.forceTick()
    expect(calls).toHaveLength(1)
    expect(scheduler.getState().lastRunDate).toBe('2026-08-08')
    const summary = settings.summaries.at(-1) ?? ''
    expect(summary).toContain('演练')
    expect(summary).toContain('孤儿 2 个')
    expect(summary).toContain('对象缺失告警 1 个')

    // 当日第二拍不重复触发
    await scheduler.forceTick()
    expect(calls).toHaveLength(1)
  })

  test('总开关关不触发', async () => {
    let called = false
    const scheduler = createFileCleanScheduler(
      deps({
        enabled: false,
        now: () => shanghai(3, 0),
        runReconcile: async () => {
          called = true
          return emptyReport()
        },
      }),
    )
    await scheduler.forceTick()
    expect(called).toBe(false)
    expect(scheduler.getState().lastRunDate).toBeNull()
  })

  test('对账抛错：写失败摘要不抛出', async () => {
    const settings = fakeSettings()
    const scheduler = createFileCleanScheduler(
      deps({
        settings: settings.service,
        now: () => shanghai(3, 0),
        runReconcile: async () => {
          throw new Error('存储不可达')
        },
      }),
    )
    await scheduler.forceTick()
    const summary = settings.summaries.at(-1) ?? ''
    expect(summary).toContain('运行异常')
    expect(summary).toContain('存储不可达')
    // 失败当日已标记，避免每分钟重试风暴（次日再试）
    expect(scheduler.getState().lastRunDate).toBe('2026-08-08')
  })

  test('摘要写回失败只记日志不影响调度', async () => {
    const scheduler = createFileCleanScheduler(
      deps({
        settings: {
          recordFileRecon: async () => {
            throw new Error('db down')
          },
        } as never,
        now: () => shanghai(3, 0),
        runReconcile: async () => emptyReport(),
      }),
    )
    await scheduler.forceTick()
    expect(scheduler.getState().lastRunDate).toBe('2026-08-08')
  })

  test('stop 后 forceTick 不再执行', async () => {
    let n = 0
    const scheduler = createFileCleanScheduler(
      deps({
        now: () => shanghai(3, 0),
        runReconcile: async () => {
          n++
          return emptyReport()
        },
      }),
    )
    scheduler.stop()
    await scheduler.forceTick()
    expect(n).toBe(0)
  })
})
