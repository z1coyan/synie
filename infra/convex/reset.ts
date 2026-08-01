#!/usr/bin/env bun

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { resolve } from 'node:path'
import {
  applyDeploymentEnv,
  buildLocalDeploymentEnv,
  captureDeploymentEnv,
  localDeploymentInputs,
  type DeploymentComposeConfig,
} from './deployment-env.ts'
import { checkInfra } from './health.ts'
import {
  assertNoConvexCloudSelection,
  composeEnv,
  localConvexEnv,
  log,
  root,
  run,
  runCompose,
  selfHostedConvexCliEnv,
  waitForHttp,
} from './lib.ts'
import {
  assertDevelopmentEnvironment,
  parseResetArgs,
  validateDockerEndpoint,
  validateNoForeignResetVolumeMounts,
  validateResetComposeConfig,
  validateResetVolumeInspections,
  type DockerContainerInspection,
  type DockerVolumeInspection,
  type ResetComposeTarget,
} from './reset-policy.ts'

const INFRA_SERVICES = [
  'convex-postgres',
  'minio',
  'minio-public',
  'minio-init',
  'convex-backend',
  'convex-dashboard',
] as const

const LOCAL_CREDENTIAL_NAMES = new Set([
  'CONVEX_SELF_HOSTED_PROJECT',
  'CONVEX_SELF_HOSTED_URL',
  'CONVEX_SELF_HOSTED_SITE_URL',
  'CONVEX_SELF_HOSTED_ADMIN_KEY',
  'VITE_CONVEX_URL',
  'VITE_CONVEX_SITE_URL',
  'VITE_SITE_URL',
])

type SetupStatus = {
  initialized: boolean
  hasUsers: boolean
}

function helpText(): string {
  return `Synie 本地 Convex 空库复位

用法：
  bun reset [--yes] [--dry-run] [--no-web] [--discard-deployment-env]
  bun db:reset [--yes] [--dry-run] [--no-web] [--discard-deployment-env]

选项：
  --yes, -y   跳过输入 Compose project name 的交互确认
  --dry-run   只执行只读安全检查并显示精确目标
  --no-web    复位后不启动 Compose Web
  --discard-deployment-env
              旧栈损坏无法导出时，明确放弃旧 deployment env
  --help, -h  显示帮助

该命令只用于本地开发，会永久删除当前工作树 Compose project 的
PostgreSQL、MinIO 与 Convex backend credential 三个 volume。`
}

function assignmentName(line: string): string | undefined {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) return undefined
  const separator = line.indexOf('=')
  if (separator < 1) return undefined
  return line.slice(0, separator).trim()
}

export function stripLocalConvexCredentials(source: string): string {
  const lines = source
    .split(/\r?\n/)
    .filter((line) => {
      const name = assignmentName(line)
      return !name || !LOCAL_CREDENTIAL_NAMES.has(name)
    })
  const content = lines.join('\n').replace(/\n+$/, '')
  return content.trim() ? `${content}\n` : ''
}

function invalidateLocalConvexCredentials(): void {
  const path = resolve(root, '.env.local')
  if (!existsSync(path)) return
  const next = stripLocalConvexCredentials(readFileSync(path, 'utf8'))
  if (!next) {
    rmSync(path)
    return
  }
  const temporary = resolve(root, '.env.local.reset.tmp')
  writeFileSync(temporary, next, { mode: 0o600 })
  chmodSync(temporary, 0o600)
  renameSync(temporary, path)
  chmodSync(path, 0o600)
}

export function parseSetupStatus(stdout: string): SetupStatus {
  let value: unknown
  try {
    value = JSON.parse(stdout)
  } catch {
    throw new Error('无法解析 Setup 状态')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Setup 状态格式无效')
  }
  const status = value as Record<string, unknown>
  if (
    typeof status.initialized !== 'boolean' ||
    typeof status.hasUsers !== 'boolean'
  ) {
    throw new Error('Setup 状态缺少布尔字段')
  }
  return {
    initialized: status.initialized,
    hasUsers: status.hasUsers,
  }
}

function serviceEnvironment(
  config: DeploymentComposeConfig,
  serviceName: string,
): Record<string, string | null> {
  const environment = config.services?.[serviceName]?.environment
  if (!environment) throw new Error(`Compose ${serviceName} 缺少 environment`)
  return environment
}

function resetRuntimeEnv(config: DeploymentComposeConfig): NodeJS.ProcessEnv {
  const web = serviceEnvironment(config, 'web')
  const viteConvexUrl = web.VITE_CONVEX_URL?.trim()
  const viteConvexSiteUrl = web.VITE_CONVEX_SITE_URL?.trim()
  const viteSiteUrl = web.VITE_SITE_URL?.trim()
  if (!viteConvexUrl || !viteConvexSiteUrl || !viteSiteUrl) {
    throw new Error('Compose Web 缺少完整 VITE_* public URL')
  }
  return {
    ...composeEnv(),
    CONVEX_CLOUD_ORIGIN: viteConvexUrl,
    SYNIE_CONVEX_PUBLIC_SITE_URL: viteConvexSiteUrl,
    VITE_CONVEX_URL: viteConvexUrl,
    VITE_CONVEX_SITE_URL: viteConvexSiteUrl,
    VITE_SITE_URL: viteSiteUrl,
  }
}

async function effectiveDockerEndpoint(env: NodeJS.ProcessEnv): Promise<string> {
  validateDockerEndpoint(env.DOCKER_HOST)
  const result = await run(
    ['docker', 'context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}'],
    { capture: true, env },
  )
  let endpoint: unknown
  try {
    endpoint = JSON.parse(result.stdout.trim())
  } catch {
    throw new Error('无法解析当前 Docker context endpoint')
  }
  if (typeof endpoint !== 'string') {
    throw new Error('当前 Docker context 没有有效 endpoint')
  }
  validateDockerEndpoint(endpoint)
  return endpoint
}

async function allDockerVolumeNames(env: NodeJS.ProcessEnv): Promise<Set<string>> {
  const result = await run(['docker', 'volume', 'ls', '--format', '{{.Name}}'], {
    capture: true,
    env,
  })
  return new Set(result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))
}

async function projectVolumeNames(
  project: string,
  env: NodeJS.ProcessEnv,
): Promise<Set<string>> {
  const result = await run(
    [
      'docker',
      'volume',
      'ls',
      '--filter',
      `label=com.docker.compose.project=${project}`,
      '--format',
      '{{.Name}}',
    ],
    { capture: true, env },
  )
  return new Set(result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))
}

async function inspectExistingDockerState(
  target: ResetComposeTarget,
  env: NodeJS.ProcessEnv,
): Promise<{ hasVolumes: boolean }> {
  const allNames = await allDockerVolumeNames(env)
  const expectedNames = new Set(target.volumes.map((volume) => volume.resolved))
  const existingNames = target.volumes
    .map((volume) => volume.resolved)
    .filter((name) => allNames.has(name))
  const labeledProjectNames = await projectVolumeNames(target.project, env)
  const extra = [...labeledProjectNames].filter((name) => !expectedNames.has(name))
  if (extra.length > 0) {
    throw new Error(`Compose project 还拥有未纳入 reset 的 volume：${extra.join('、')}`)
  }
  if (existingNames.length === 0) {
    if (labeledProjectNames.size > 0) {
      throw new Error('Compose project volume 标签与预期名称不一致')
    }
    return { hasVolumes: false }
  }
  if (existingNames.length !== target.volumes.length) {
    throw new Error('本地 reset 三卷只存在一部分；拒绝在不完整归属上删除')
  }

  const volumeResult = await run(['docker', 'volume', 'inspect', ...existingNames], {
    capture: true,
    env,
  })
  const inspections = JSON.parse(volumeResult.stdout) as DockerVolumeInspection[]
  validateResetVolumeInspections(target, inspections)

  const containerIds = new Set<string>()
  for (const name of existingNames) {
    const result = await run(
      ['docker', 'ps', '-aq', '--filter', `volume=${name}`],
      { capture: true, env },
    )
    for (const id of result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
      containerIds.add(id)
    }
  }
  let containers: DockerContainerInspection[] = []
  if (containerIds.size > 0) {
    const result = await run(['docker', 'inspect', ...containerIds], {
      capture: true,
      env,
    })
    containers = JSON.parse(result.stdout) as DockerContainerInspection[]
  }
  validateNoForeignResetVolumeMounts(target, root, containers)
  return { hasVolumes: true }
}

async function runningComposeServices(env: NodeJS.ProcessEnv): Promise<Set<string>> {
  const result = await runCompose(['ps', '--status', 'running', '--services'], {
    capture: true,
    env,
  })
  return new Set(result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))
}

async function confirmReset(project: string): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('非交互终端必须显式传入 --yes')
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await prompt.question(`请输入 Compose project name “${project}” 确认永久删除：`)
    if (answer !== project) throw new Error('project name 不匹配，已取消 reset')
  } finally {
    prompt.close()
  }
}

function writeRecoveryFile(project: string, source: string): string {
  const directory = resolve(root, 'infra/convex/backups')
  mkdirSync(directory, { recursive: true })
  const timestamp = new Date().toISOString().replaceAll(/[:.]/g, '-')
  const path = resolve(directory, `reset-recovery-${project}-${timestamp}.env`)
  writeFileSync(path, source, { mode: 0o600, flag: 'wx' })
  chmodSync(path, 0o600)
  return path
}

function findExistingRecoveryFile(project: string): string | undefined {
  const directory = resolve(root, 'infra/convex/backups')
  if (!existsSync(directory)) return undefined
  const prefix = `reset-recovery-${project}-`
  const names = readdirSync(directory)
    .filter((name) => {
      if (!name.startsWith(prefix) || !name.endsWith('.env')) return false
      const timestamp = name.slice(prefix.length, -'.env'.length)
      return /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/.test(timestamp)
    })
    .sort()
  const name = names.at(-1)
  if (!name) return undefined
  const path = resolve(directory, name)
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('reset recovery 必须是普通文件且不能是符号链接')
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error('reset recovery 权限必须为 0600')
  }
  return path
}

function refreshRecoveryFile(path: string, source: string): void {
  const temporary = `${path}.tmp`
  try {
    writeFileSync(temporary, source, { mode: 0o600, flag: 'wx' })
    chmodSync(temporary, 0o600)
    renameSync(temporary, path)
    chmodSync(path, 0o600)
  } finally {
    rmSync(temporary, { force: true })
  }
}

function removeStaleAdminCredential(project: string): void {
  const path = resolve(
    root,
    'infra/convex/backups',
    `final-local-admin-${project}.txt`,
  )
  if (!existsSync(path)) return
  rmSync(path)
  log(`已删除失效的本地 ERP 管理员凭据文件：${path}`)
}

async function assertVolumesRemoved(
  target: ResetComposeTarget,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const names = await allDockerVolumeNames(env)
  const remaining = target.volumes
    .map((volume) => volume.resolved)
    .filter((name) => names.has(name))
  if (remaining.length > 0) {
    throw new Error(`reset 后仍存在目标 volume：${remaining.join('、')}`)
  }
}

async function assertFreshSetup(env: NodeJS.ProcessEnv): Promise<void> {
  const result = await run(
    ['bunx', 'convex', 'run', 'setup/status:get', '{}'],
    { cwd: root, env, capture: true },
  )
  const status = parseSetupStatus(result.stdout)
  if (status.initialized || status.hasUsers) {
    throw new Error(
      `reset 后 Setup 状态不为空（initialized=${status.initialized}, hasUsers=${status.hasUsers}）`,
    )
  }
}

async function main(): Promise<void> {
  const args = parseResetArgs(process.argv.slice(2))
  if (args.help) {
    console.log(helpText())
    return
  }

  assertDevelopmentEnvironment(process.env)
  assertNoConvexCloudSelection(process.env)
  const env = composeEnv()
  await effectiveDockerEndpoint(env)
  const rendered = await runCompose(['config', '--format', 'json'], {
    capture: true,
    env,
    sensitiveOutput: true,
  })
  const config = JSON.parse(rendered.stdout) as DeploymentComposeConfig
  let target = validateResetComposeConfig(config, root)
  const dockerState = await inspectExistingDockerState(target, env)
  const localBefore = localConvexEnv()
  const credentialProject = localBefore.CONVEX_SELF_HOSTED_PROJECT?.trim()
  if (dockerState.hasVolumes && credentialProject) {
    target = validateResetComposeConfig(config, root, credentialProject)
  }
  const servicesBefore = await runningComposeServices(env)
  const inputs = localDeploymentInputs(config, resetRuntimeEnv(config))

  console.log('[synie:reset] 将永久删除以下本地开发数据：')
  console.log(`  workspace → ${root}`)
  console.log(`  project   → ${target.project}`)
  for (const volume of target.volumes) {
    console.log(`  volume    → ${volume.resolved}`)
  }
  console.log(`  Web       → ${args.startWeb ? '复位后启动' : '复位后不启动'}`)
  console.log(
    `  env       → ${args.discardDeploymentEnv ? '明确丢弃旧值并重建必需项' : '先安全保存旧值'}`,
  )

  if (args.dryRun) {
    log('dry-run 通过：未修改 container、volume、凭据或 deployment')
    return
  }
  if (!args.yes) await confirmReset(target.project)

  const existingRecoveryPath = findExistingRecoveryFile(target.project)
  let captured = !args.discardDeploymentEnv && existingRecoveryPath
    ? readFileSync(existingRecoveryPath, 'utf8')
    : ''
  if (args.discardDeploymentEnv) {
    log('已明确选择丢弃旧 deployment env；只从当前 Compose/.env 重建必需项')
  } else if (existingRecoveryPath) {
    log('发现上次中断保留的 0600 deployment recovery；本次跳过旧 deployment 健检')
  } else if (dockerState.hasVolumes) {
    log('删除前启动并健检现有 deployment，以静默保存 deployment env')
    await runCompose(['up', '-d', ...INFRA_SERVICES], { env })
    await checkInfra({ env })
    await run(['bun', 'run', 'convex:bootstrap'], { cwd: root, env })
    captured = await captureDeploymentEnv({ ...env, ...localConvexEnv() })
  }
  const deploymentSource = buildLocalDeploymentEnv(captured, inputs, {
    rotateBetterAuthSecret: args.discardDeploymentEnv || !existingRecoveryPath,
    env,
  })
  const recoveryPath =
    existingRecoveryPath ?? writeRecoveryFile(target.project, deploymentSource)
  if (existingRecoveryPath) refreshRecoveryFile(recoveryPath, deploymentSource)
  let destructiveStarted = false
  let completed = false
  try {
    destructiveStarted = true
    log(`删除 Compose project ${target.project} 的三个精确数据卷`)
    await runCompose(['down', '--remove-orphans'], { env })
    if (dockerState.hasVolumes) {
      await run(
        [
          'docker',
          'volume',
          'rm',
          ...target.volumes.map((volume) => volume.resolved),
        ],
        { env },
      )
    }
    await assertVolumesRemoved(target, env)
    invalidateLocalConvexCredentials()
    removeStaleAdminCredential(target.project)

    log('重建 PostgreSQL、MinIO、Convex backend/dashboard')
    await runCompose(['up', '-d', ...INFRA_SERVICES], { env })
    await checkInfra({ env })
    await run(['bun', 'run', 'convex:bootstrap'], { cwd: root, env })
    const deploymentEnv = selfHostedConvexCliEnv({
      ...env,
      ...localConvexEnv(),
    })
    await applyDeploymentEnv(deploymentSource, deploymentEnv)
    await run(
      ['bunx', 'convex', 'dev', '--once', '--typecheck-components'],
      { cwd: root, env: deploymentEnv },
    )
    await assertFreshSetup(deploymentEnv)

    if (args.startWeb) {
      log('构建并启动当前工作树 Web')
      await runCompose(['up', '-d', '--build', 'web'], { env })
      const loopbackSetupUrl = `http://127.0.0.1:${env.WEB_PORT ?? '3000'}/setup`
      const response = await waitForHttp('Web Setup', loopbackSetupUrl, 180)
      if (response.status !== 200) {
        throw new Error(`Web /setup 预期 HTTP 200，实际 ${response.status}`)
      }
    }

    await runCompose(['rm', '-f', 'minio-init'], { env, allowFailure: true })
    completed = true
    rmSync(recoveryPath)
    log('reset 完成：initialized=false, hasUsers=false')
    if (args.startWeb) log(`Setup → ${inputs.siteUrl}/setup`)
    if (!servicesBefore.has('web') && args.startWeb) {
      log('Web 原先未运行，本次按 reset 默认契约启动')
    }
  } finally {
    if (!completed) {
      if (!destructiveStarted) rmSync(recoveryPath, { force: true })
      else {
        console.error(
          `[synie:reset] reset 中断；0600 deployment recovery 已保留：${recoveryPath}`,
        )
      }
    }
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error('[synie:reset] 失败:', error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
