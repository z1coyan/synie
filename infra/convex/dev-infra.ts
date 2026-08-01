import { checkInfra } from './health.ts'
import { log, runCompose } from './lib.ts'

async function main() {
  const convexOnly = process.argv.includes('--convex-only')
  const services = [
    ...(convexOnly ? [] : ['postgres']),
    'convex-postgres',
    'minio',
    'minio-public',
    'minio-init',
    'convex-backend',
    'convex-dashboard',
  ]
  log(`启动 ${services.join(', ')}`)
  await runCompose(['up', '-d', ...services])
  await checkInfra({ includeLegacyPostgres: !convexOnly })
}

main().catch((error) => {
  console.error('[synie:convex] 启动失败:', error instanceof Error ? error.message : error)
  console.error('[synie:convex] 诊断：docker compose logs convex-postgres minio convex-backend convex-dashboard')
  process.exit(1)
})
