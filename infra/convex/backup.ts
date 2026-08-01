import { createHash } from 'node:crypto'
import { chmodSync, createReadStream, existsSync, mkdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, resolve } from 'node:path'
import { log, requireLocalConvexCredentials, run } from './lib.ts'

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

export function requireSafeOutputDirectory(raw: string | undefined): string {
  const input = raw?.trim()
  if (!input || input === '~' || input.startsWith('~/')) {
    throw new Error('必须显式提供输出目录；拒绝空路径与 ~')
  }
  const output = resolve(input)
  if (output === '/' || output === homedir()) {
    throw new Error(`拒绝过宽输出目录：${output}`)
  }
  if (existsSync(output) && !statSync(output).isDirectory()) {
    throw new Error(`输出路径不是目录：${output}`)
  }
  mkdirSync(output, { recursive: true, mode: 0o700 })
  return output
}

export async function exportSnapshot(outputDirectory: string): Promise<string> {
  const env = requireLocalConvexCredentials()
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('Z', 'Z')
  const snapshot = resolve(outputDirectory, `synie-convex-${stamp}.zip`)
  const started = performance.now()
  await run(
    ['bunx', 'convex', 'export', '--include-file-storage', '--path', snapshot],
    { env },
  )
  chmodSync(snapshot, 0o600)
  const checksum = await sha256File(snapshot)
  const seconds = ((performance.now() - started) / 1_000).toFixed(2)
  log(
    `snapshot=${basename(snapshot)} source=${env.CONVEX_SELF_HOSTED_URL} sha256=${checksum} elapsed=${seconds}s`,
  )
  return snapshot
}

if (import.meta.main) {
  try {
    const output = requireSafeOutputDirectory(process.argv[2])
    const snapshot = await exportSnapshot(output)
    console.log(snapshot)
  } catch (error) {
    console.error('[synie:convex] 备份失败:', error instanceof Error ? error.message : error)
    process.exit(1)
  }
}
