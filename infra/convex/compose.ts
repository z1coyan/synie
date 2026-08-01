import { runCompose } from './lib.ts'

const args = process.argv.slice(2)
if (args.length === 0) {
  console.error('用法: bun infra/convex/compose.ts <docker compose args...>')
  process.exit(2)
}

runCompose(args).catch((error) => {
  console.error('[synie:convex] Compose 命令失败:', error instanceof Error ? error.message : error)
  process.exit(1)
})
