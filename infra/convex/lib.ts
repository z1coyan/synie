import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export const root = resolve(import.meta.dir, '../..')

const VERSION_PATTERN = /^[0-9a-f]{40}$/

function parseEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {}
  const values: Record<string, string> = {}
  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const separator = line.indexOf('=')
    if (separator < 1) continue
    const key = line.slice(0, separator).trim()
    let value = line.slice(separator + 1).trim()
    if (
      (value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"'))
    ) {
      value = value.slice(1, -1)
    }
    values[key] = value
  }
  return values
}

export function expectedConvexVersion(env: NodeJS.ProcessEnv = process.env): string {
  const version =
    env.CONVEX_VERSION ??
    parseEnvFile(resolve(root, '.env')).CONVEX_VERSION ??
    parseEnvFile(resolve(root, '.env.example')).CONVEX_VERSION
  if (!version || !VERSION_PATTERN.test(version)) {
    throw new Error('CONVEX_VERSION 必须是 40 位固定 commit tag；请检查 .env/.env.example')
  }
  return version
}

export function composeEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CONVEX_VERSION: expectedConvexVersion(process.env),
    SYNIE_COMPOSE_WORKSPACE: root,
    ...overrides,
  }
}

export type RunResult = {
  exitCode: number
  stdout: string
  stderr: string
}

export async function run(
  command: readonly string[],
  options: {
    capture?: boolean
    env?: NodeJS.ProcessEnv
    allowFailure?: boolean
    sensitiveOutput?: boolean
    cwd?: string
  } = {},
): Promise<RunResult> {
  const capture = options.capture ?? false
  const child = Bun.spawn([...command], {
    cwd: options.cwd ?? root,
    env: options.env ?? composeEnv(),
    stdin: 'ignore',
    stdout: capture ? 'pipe' : 'inherit',
    stderr: capture ? 'pipe' : 'inherit',
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    capture ? new Response(child.stdout).text() : Promise.resolve(''),
    capture ? new Response(child.stderr).text() : Promise.resolve(''),
  ])
  if (exitCode !== 0 && !options.allowFailure) {
    const detail = capture
      ? options.sensitiveOutput
        ? '\n<敏感命令输出已隐藏>'
        : `\n${stderr || stdout}`
      : ''
    throw new Error(`命令失败 (${exitCode}): ${command.join(' ')}${detail}`)
  }
  return { exitCode, stdout, stderr }
}

export async function composeProjectName(env: NodeJS.ProcessEnv = composeEnv()): Promise<string> {
  const result = await run(
    ['docker', 'compose', 'config', '--format', 'json'],
    { capture: true, env },
  )
  const config = JSON.parse(result.stdout) as { name?: string }
  if (!config.name || !/^[a-z0-9][a-z0-9_-]*$/.test(config.name)) {
    throw new Error('无法解析 Compose project name')
  }
  return config.name
}

async function assertComposeOwnership(env: NodeJS.ProcessEnv): Promise<void> {
  const project = await composeProjectName(env)
  const result = await run(
    [
      'docker',
      'ps',
      '-a',
      '--filter',
      `label=com.docker.compose.project=${project}`,
      '--format',
      '{{.Label "com.docker.compose.project.config_files"}}\t{{.Label "com.docker.compose.project.working_dir"}}',
    ],
    { capture: true, env },
  )
  const expectedConfig = resolve(root, 'compose.yaml')
  for (const line of result.stdout.trim().split(/\r?\n/).filter(Boolean)) {
    const [configFiles, workingDirectory] = line.split('\t')
    const ownsConfig = configFiles
      ?.split(',')
      .map((value) => resolve(value))
      .includes(expectedConfig)
    if (!ownsConfig || resolve(workingDirectory ?? '') !== root) {
      throw new Error(
        `Compose project ${project} 已属于另一工作树；拒绝操作（config=${configFiles ?? 'unknown'}）`,
      )
    }
  }
}

export async function runCompose(
  args: readonly string[],
  options: Parameters<typeof run>[1] = {},
): Promise<RunResult> {
  const env = options.env ?? composeEnv()
  if (args[0] !== 'config' && args[0] !== 'version') {
    await assertComposeOwnership(env)
  }
  return run(['docker', 'compose', ...args], {
    ...options,
    env,
  })
}

export function localConvexEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const local = parseEnvFile(resolve(root, '.env.local'))
  return {
    ...composeEnv(),
    ...local,
    ...overrides,
  }
}

export function requireLocalConvexCredentials(): NodeJS.ProcessEnv {
  const env = localConvexEnv()
  if (!env.CONVEX_SELF_HOSTED_URL || !env.CONVEX_SELF_HOSTED_ADMIN_KEY) {
    throw new Error('缺少本地 Convex 凭据；请先运行 bun run convex:bootstrap')
  }
  return env
}

export async function waitForHttp(
  label: string,
  url: string,
  attempts = 90,
): Promise<Response> {
  let lastError = ''
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, { redirect: 'manual' })
      if (response.status >= 200 && response.status < 400) return response
      lastError = `HTTP ${response.status}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    if (attempt < attempts) await Bun.sleep(1_000)
  }
  throw new Error(`${label} 未就绪 (${url}): ${lastError}`)
}

export function log(message: string) {
  console.log(`[synie:convex] ${message}`)
}
