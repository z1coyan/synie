import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { composeProjectName, log, root, runCompose } from './lib.ts'

function upsertEnv(source: string, values: Readonly<Record<string, string>>): string {
  const pending = new Map(Object.entries(values))
  const lines = source ? source.split(/\r?\n/) : []
  const next = lines.map((line) => {
    const separator = line.indexOf('=')
    if (separator < 1 || line.trimStart().startsWith('#')) return line
    const key = line.slice(0, separator).trim()
    const value = pending.get(key)
    if (value === undefined) return line
    pending.delete(key)
    return `${key}=${value}`
  })
  if (next.length > 0 && next.at(-1) !== '') next.push('')
  for (const [key, value] of pending) next.push(`${key}=${value}`)
  return `${next.join('\n').replace(/\n+$/, '')}\n`
}

async function main() {
  const result = await runCompose(
    ['exec', '-T', 'convex-backend', './generate_admin_key.sh'],
    { capture: true, sensitiveOutput: true },
  )
  const key = result.stdout.trim().split(/\r?\n/).at(-1)?.trim()
  if (!key || key.length < 32 || /\s/.test(key)) {
    throw new Error('无法从官方 generate_admin_key.sh 解析 admin key')
  }

  const envPath = resolve(root, '.env.local')
  const tempPath = resolve(root, '.env.local.tmp')
  const existing = existsSync(envPath) ? readFileSync(envPath, 'utf8') : ''
  const publicSiteUrl =
    process.env.SYNIE_CONVEX_PUBLIC_SITE_URL ??
    `http://127.0.0.1:${process.env.CONVEX_SITE_PORT ?? '3211'}`
  const content = upsertEnv(existing, {
    CONVEX_SELF_HOSTED_PROJECT: await composeProjectName(),
    CONVEX_SELF_HOSTED_URL: process.env.CONVEX_CLOUD_ORIGIN ?? 'http://127.0.0.1:3210',
    CONVEX_SELF_HOSTED_SITE_URL: publicSiteUrl,
    VITE_CONVEX_URL: process.env.CONVEX_CLOUD_ORIGIN ?? 'http://127.0.0.1:3210',
    VITE_CONVEX_SITE_URL: publicSiteUrl,
    VITE_SITE_URL: process.env.VITE_SITE_URL ?? 'http://localhost:3000',
    CONVEX_SELF_HOSTED_ADMIN_KEY: key,
  })
  writeFileSync(tempPath, content, { mode: 0o600 })
  chmodSync(tempPath, 0o600)
  renameSync(tempPath, envPath)
  chmodSync(envPath, 0o600)
  log('admin key 已静默写入 .env.local（权限 0600，未输出 key）')
}

main().catch((error) => {
  console.error('[synie:convex] bootstrap 失败:', error instanceof Error ? error.message : error)
  process.exit(1)
})
