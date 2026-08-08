/**
 * 文件存储对账（janitor 的领域逻辑；调度见 jobs/filesclean）。
 *
 * 背景：deleteFile 先删 DB 行再删对象，对象删除失败仅告警，孤儿对象会永久沉淀；
 * 上传则先写对象后落库，中途失败同样留下孤儿。本服务定期双向比对：
 * - 存储有对象、sys_file 无行 → 孤儿（超宽限期才处理；上传进行中的新对象不碰）
 * - sys_file 有行、存储无对象 → 缺失（只报告，元数据不代删）
 *
 * 默认 dry-run（只报告不删除），由调度侧注入配置；本服务无鉴权面，仅供受信任后台链路调用。
 */
import type { Kysely } from 'kysely'
import type { DB as Database } from '~/db/types.ts'
import { objectStorageByName } from './service.ts'

export interface FileReconcileDeps {
  db: Kysely<Database>
}

export interface FileReconcileOptions {
  /** true：只报告不删除（安全默认） */
  dryRun: boolean
  /** 孤儿宽限（毫秒）：修改时间新于 now-宽限 的对象视为进行中上传，不算孤儿 */
  orphanGraceMs: number
  /** 可注入时钟（测试）；默认当前时刻 */
  now?: Date
}

export interface StorageReconcileReport {
  storage: string
  /** 该接入点扫描失败（配置不全/对象存储不可达等）时的错误；成功为 null */
  error: string | null
  objectCount: number
  dbRowCount: number
  /** 超宽限期的孤儿 key（dry-run 下未删除），按字典序 */
  orphans: string[]
  /** 宽限期内的对象数（疑似进行中上传，本轮不处理） */
  freshOrphans: number
  /** 实际删除成功数（dry-run 恒 0） */
  deleted: number
  /** 删除失败数（下轮重试） */
  deleteFailed: number
  /** DB 有行但对象缺失的 key（只告警），按字典序 */
  missing: string[]
}

export interface FileReconcileReport {
  dryRun: boolean
  storages: StorageReconcileReport[]
}

export function createFileReconcileService(deps: FileReconcileDeps) {
  const { db } = deps

  async function reconcile(options: FileReconcileOptions): Promise<FileReconcileReport> {
    const now = options.now ?? new Date()
    const cutoffMs = now.getTime() - options.orphanGraceMs
    const endpoints = await db
      .selectFrom('sys_storage')
      .select(['name', 'label'])
      .orderBy('name')
      .execute()

    const storages: StorageReconcileReport[] = []
    for (const endpoint of endpoints) {
      const report: StorageReconcileReport = {
        storage: endpoint.name,
        error: null,
        objectCount: 0,
        dbRowCount: 0,
        orphans: [],
        freshOrphans: 0,
        deleted: 0,
        deleteFailed: 0,
        missing: [],
      }
      storages.push(report)
      try {
        const store = await objectStorageByName(db, endpoint.name)
        const objects = await store.list()
        const rows = await db
          .selectFrom('sys_file')
          .select('key')
          .where('storage', '=', endpoint.name)
          .execute()
        const dbKeys = new Set(rows.map((row) => row.key))
        const objectKeys = new Set(objects.map((object) => object.key))
        report.objectCount = objects.length
        report.dbRowCount = rows.length

        for (const object of objects) {
          if (dbKeys.has(object.key)) continue
          // 修改时间不明一律按超宽限处理（宁可报告，不漏孤儿）
          if (object.modifiedAt !== null && object.modifiedAt.getTime() > cutoffMs) {
            report.freshOrphans += 1
          } else {
            report.orphans.push(object.key)
          }
        }
        for (const row of rows) {
          if (!objectKeys.has(row.key)) report.missing.push(row.key)
        }
        report.orphans.sort()
        report.missing.sort()

        if (!options.dryRun) {
          for (const key of report.orphans) {
            try {
              await store.delete(key)
              report.deleted += 1
            } catch {
              report.deleteFailed += 1
            }
          }
        }
      } catch (err) {
        report.error = err instanceof Error ? err.message : String(err)
      }
    }
    return { dryRun: options.dryRun, storages }
  }

  return { reconcile }
}

export type FileReconcileService = ReturnType<typeof createFileReconcileService>

/** 运行摘要（落 sys_setting.file_recon_last_summary，中文、单行、500 字截断） */
export function summarizeFileReconcile(report: FileReconcileReport): string {
  const mode = report.dryRun ? '演练' : '执行'
  let orphans = 0
  let deleted = 0
  let deleteFailed = 0
  let missing = 0
  const failed: string[] = []
  for (const s of report.storages) {
    orphans += s.orphans.length
    deleted += s.deleted
    deleteFailed += s.deleteFailed
    missing += s.missing.length
    if (s.error) failed.push(s.storage)
  }
  const parts = [
    `文件存储对账（${mode}）：接入点 ${report.storages.length} 个`,
    `孤儿 ${orphans} 个（删除 ${deleted}、失败 ${deleteFailed}）`,
    `对象缺失告警 ${missing} 个`,
  ]
  if (failed.length > 0) parts.push(`扫描失败接入点：${failed.join('、')}`)
  const summary = parts.join('；')
  const runes = [...summary]
  return runes.length > 500 ? runes.slice(0, 500).join('') : summary
}
