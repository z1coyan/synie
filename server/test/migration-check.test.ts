import { describe, expect, test } from 'bun:test'
import { listMigrationFiles, missingMigrations } from '../db/migration-check.ts'

describe('迁移版本比对（纯函数）', () => {
  test('全部已应用：无缺失', () => {
    expect(missingMigrations(['00001_a.sql', '00002_b.sql'], ['00001_a.sql', '00002_b.sql'])).toEqual([])
  })

  test('落后：按磁盘顺序返回缺失清单', () => {
    expect(missingMigrations(['00001_a.sql', '00002_b.sql', '00003_c.sql'], ['00001_a.sql'])).toEqual([
      '00002_b.sql',
      '00003_c.sql',
    ])
  })

  test('从未迁移（追踪表为空）：全部缺失', () => {
    expect(missingMigrations(['00001_a.sql'], [])).toEqual(['00001_a.sql'])
  })

  test('已应用多于磁盘（未来版本/压平重建后）：不视为缺失', () => {
    expect(missingMigrations(['00001_a.sql'], ['00001_a.sql', '00002_old.sql'])).toEqual([])
  })
})

describe('磁盘迁移清单', () => {
  test('listMigrationFiles 与仓库内 db/migrations 一致（字典序）', async () => {
    const files = await listMigrationFiles()
    expect(files.length).toBeGreaterThan(0)
    expect(files.every((f) => f.endsWith('.sql'))).toBe(true)
    expect([...files].sort()).toEqual(files)
  })
})
