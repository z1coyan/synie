import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { root } from './lib.ts'

const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10)
const outputDirectory = join(
  root,
  'infra/convex/backups',
  `restore-smoke-${new Date().toISOString().replaceAll(':', '-')}-${suffix}`,
)
const targetProject = `synie-restore-${suffix}`
mkdirSync(outputDirectory, { recursive: true, mode: 0o700 })

const child = Bun.spawn(
  ['bun', 'infra/convex/restore-smoke.ts', outputDirectory, targetProject],
  {
    cwd: root,
    env: {
      ...process.env,
      RESTORE_CONVEX_POSTGRES_PORT: process.env.RESTORE_CONVEX_POSTGRES_PORT ?? '16442',
      RESTORE_MINIO_API_PORT: process.env.RESTORE_MINIO_API_PORT ?? '20000',
      RESTORE_MINIO_CONSOLE_PORT: process.env.RESTORE_MINIO_CONSOLE_PORT ?? '20001',
      RESTORE_CONVEX_PORT: process.env.RESTORE_CONVEX_PORT ?? '14210',
      RESTORE_CONVEX_SITE_PORT: process.env.RESTORE_CONVEX_SITE_PORT ?? '14211',
      RESTORE_CONVEX_DASHBOARD_PORT:
        process.env.RESTORE_CONVEX_DASHBOARD_PORT ?? '17791',
    },
    stdin: 'ignore',
    stdout: 'inherit',
    stderr: 'inherit',
  },
)

const exitCode = await child.exited
if (exitCode !== 0) process.exit(exitCode)

console.log(`[synie:convex] 恢复演练备份已保留：${outputDirectory}`)
