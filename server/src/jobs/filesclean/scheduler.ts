import {
  summarizeFileReconcile,
  type FileReconcileReport,
  type FileReconcileService,
} from '~/platform/files/reconcile.ts'
import { systemPermit } from '~/platform/authz/core/index.ts'
import { SYS_RESOURCE_NAME } from '~/platform/settings/meta.ts'
import type { SettingsService } from '~/platform/settings/service.ts'
import {
  decideFileClean,
  emptyFileCleanState,
  type FileCleanState,
} from './decision.ts'

const INITIAL_DELAY_MS = 30_000
const TICK_INTERVAL_MS = 60_000

export interface FileCleanSchedulerDeps {
  settings: Pick<SettingsService, 'recordFileRecon'>
  reconcile: Pick<FileReconcileService, 'reconcile'>
  /** 总开关（env）；关则 tick 空转 */
  enabled: boolean
  /** 演练模式：只报告不删除孤儿对象 */
  dryRun: boolean
  /** 孤儿宽限（毫秒） */
  orphanGraceMs: number
  /** 每日运行时刻（上海时区小时，0-23） */
  runHour: number
  /** 可注入时钟（测试）；默认 Date.now */
  now?: () => Date
  runReconcile?: (now: Date) => Promise<FileReconcileReport>
  log?: (level: 'info' | 'error', msg: string, extra?: Record<string, unknown>) => void
}

/**
 * 进程内文件存储对账调度：setInterval 形态，与 marketsched 同款。
 * 单线程同步跑 tick（上一轮未完不并发）；stop() 优雅停机。
 * 单实例假设（KD24）：多副本部署会各自对账——dry-run 下无害，
 * 执行模式下删除幂等（对象已删视为成功），但摘要多写。
 */
export function createFileCleanScheduler(deps: FileCleanSchedulerDeps) {
  const nowFn = deps.now ?? (() => new Date())
  let state: FileCleanState = emptyFileCleanState()
  let running = false
  let stopped = false
  let initialTimer: ReturnType<typeof setTimeout> | null = null
  let tickTimer: ReturnType<typeof setInterval> | null = null

  function log(
    level: 'info' | 'error',
    msg: string,
    extra?: Record<string, unknown>,
  ): void {
    if (deps.log) {
      deps.log(level, msg, extra)
      return
    }
    console.log(JSON.stringify({ level, msg, ...extra }))
  }

  async function tick(): Promise<void> {
    if (stopped || running) return
    running = true
    try {
      const now = nowFn()
      const decision = decideFileClean(
        { enabled: deps.enabled, runHour: deps.runHour },
        now,
        state,
      )
      state = decision.next
      if (decision.shouldRun) {
        log('info', '文件存储对账: 触发', {
          at: now.toISOString(),
          dryRun: deps.dryRun,
        })
        await runSafely(async () => {
          if (deps.runReconcile) return deps.runReconcile(now)
          return deps.reconcile.reconcile({
            dryRun: deps.dryRun,
            orphanGraceMs: deps.orphanGraceMs,
            now,
          })
        })
      }
    } catch (err) {
      log('error', '文件存储对账节拍失败', { error: String(err) })
    } finally {
      running = false
    }
  }

  /** 成败均落 sys_setting 摘要（运维可见性），摘要写回失败只记日志不再抛 */
  async function runSafely(run: () => Promise<FileReconcileReport>): Promise<void> {
    let summary: string
    try {
      summary = summarizeFileReconcile(await run())
    } catch (err) {
      summary = `文件存储对账: 运行异常: ${err instanceof Error ? err.message : String(err)}`
      log('error', '文件存储对账运行失败', { error: String(err) })
    }
    log('info', '文件存储对账结果', { summary })
    try {
      await deps.settings.recordFileRecon(systemPermit(SYS_RESOURCE_NAME, 'update'), summary)
    } catch (writeErr) {
      log('error', '文件存储对账摘要写回失败', { error: String(writeErr) })
    }
  }

  function start(): void {
    if (initialTimer || tickTimer) return
    stopped = false
    initialTimer = setTimeout(() => {
      initialTimer = null
      void tick()
      if (stopped) return
      tickTimer = setInterval(() => {
        void tick()
      }, TICK_INTERVAL_MS)
    }, INITIAL_DELAY_MS)
  }

  function stop(): void {
    stopped = true
    if (initialTimer) {
      clearTimeout(initialTimer)
      initialTimer = null
    }
    if (tickTimer) {
      clearInterval(tickTimer)
      tickTimer = null
    }
  }

  /** 测试用：同步跑一拍 */
  async function forceTick(): Promise<void> {
    await tick()
  }

  function getState(): FileCleanState {
    return { lastRunDate: state.lastRunDate }
  }

  return { start, stop, forceTick, getState }
}

export type FileCleanScheduler = ReturnType<typeof createFileCleanScheduler>
