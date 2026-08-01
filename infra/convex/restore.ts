import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { sha256File } from './backup.ts'
import { composeEnv, log, run } from './lib.ts'

export function requireTargetProject(raw: string | undefined): string {
  const project = raw?.trim()
  if (!project || !/^[a-z0-9][a-z0-9_-]{2,62}$/.test(project)) {
    throw new Error('必须提供 3–63 位小写 target project name')
  }
  return project
}

export function requireSnapshot(raw: string | undefined): string {
  if (!raw?.trim()) throw new Error('必须显式提供 snapshot.zip')
  const path = resolve(raw)
  if (!existsSync(path) || !statSync(path).isFile() || !path.endsWith('.zip')) {
    throw new Error(`snapshot 不存在或不是 zip：${path}`)
  }
  return path
}

export async function assertFreshComposeProject(project: string, env: NodeJS.ProcessEnv) {
  const checks: ReadonlyArray<readonly string[]> = [
    ['docker', 'ps', '-a', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.ID}}'],
    ['docker', 'volume', 'ls', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.Name}}'],
    ['docker', 'network', 'ls', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.ID}}'],
  ]
  for (const command of checks) {
    const result = await run(command, { capture: true, env })
    if (result.stdout.trim()) {
      throw new Error(`目标 Compose project ${project} 已有 container/volume/network；恢复只允许全新目标`)
    }
  }
}

export async function importSnapshot(options: {
  snapshot: string
  targetProject: string
  targetUrl: string
  targetAdminKey: string
}) {
  if (!options.targetAdminKey || options.targetAdminKey.length < 32) {
    throw new Error('缺少目标 deployment admin key')
  }
  const started = performance.now()
  const env = composeEnv({
    CONVEX_SELF_HOSTED_URL: options.targetUrl,
    CONVEX_SELF_HOSTED_ADMIN_KEY: options.targetAdminKey,
  })
  await run(
    ['bunx', 'convex', 'import', '--replace-all', '--yes', options.snapshot],
    { env },
  )
  const checksum = await sha256File(options.snapshot)
  const seconds = ((performance.now() - started) / 1_000).toFixed(2)
  log(
    `restore target=${options.targetProject} url=${options.targetUrl} sha256=${checksum} elapsed=${seconds}s`,
  )
}

if (import.meta.main) {
  try {
    const snapshot = requireSnapshot(process.argv[2])
    const targetProject = requireTargetProject(process.argv[3])
    const targetUrl = process.env.CONVEX_TARGET_URL
    const targetAdminKey = process.env.CONVEX_TARGET_ADMIN_KEY
    if (!targetUrl || !targetAdminKey) {
      throw new Error('必须通过 CONVEX_TARGET_URL/CONVEX_TARGET_ADMIN_KEY 注入目标；禁止把 key 放 CLI 参数')
    }
    await importSnapshot({ snapshot, targetProject, targetUrl, targetAdminKey })
  } catch (error) {
    console.error('[synie:convex] 恢复失败:', error instanceof Error ? error.message : error)
    process.exit(1)
  }
}
