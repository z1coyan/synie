import { join, resolve } from 'node:path'

export type ResetArgs = {
  yes: boolean
  dryRun: boolean
  startWeb: boolean
  discardDeploymentEnv: boolean
  help: boolean
}

export type ResetVolumeLogicalName =
  | 'convex-postgres'
  | 'synie-minio'
  | 'convex-backend-data'

export type ResetVolumeTarget = {
  logical: ResetVolumeLogicalName
  resolved: string
  service: 'convex-postgres' | 'minio' | 'convex-backend'
  target: '/var/lib/postgresql/data' | '/data' | '/convex/data'
}

export type ResetComposeTarget = {
  project: string
  volumes: readonly ResetVolumeTarget[]
}

export type DockerVolumeInspection = {
  Name?: unknown
  Labels?: unknown
}

export type DockerContainerInspection = {
  Name?: unknown
  Config?: unknown
  Mounts?: unknown
}

const RESET_VOLUME_SPECS = [
  {
    logical: 'convex-postgres',
    service: 'convex-postgres',
    target: '/var/lib/postgresql/data',
  },
  {
    logical: 'synie-minio',
    service: 'minio',
    target: '/data',
  },
  {
    logical: 'convex-backend-data',
    service: 'convex-backend',
    target: '/convex/data',
  },
] as const satisfies ReadonlyArray<
  Omit<ResetVolumeTarget, 'resolved'>
>

const SAFE_ENVIRONMENT_VALUES = new Set(['development', 'dev', 'test', 'local'])
const ENVIRONMENT_MARKERS = ['NODE_ENV', 'SYNIE_ENV', 'APP_ENV'] as const

type UnknownRecord = Record<string, unknown>

function requireRecord(value: unknown, label: string): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象`)
  }
  return value as UnknownRecord
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} 必须是非空字符串`)
  }
  return value
}

function normalizedWorkspace(workspace: string): string {
  if (!workspace.trim()) throw new Error('workspace 不能为空')
  const normalized = resolve(workspace)
  if (normalized === resolve('/')) throw new Error('workspace 不能是文件系统根目录')
  return normalized
}

function labelsFrom(value: unknown, label: string): Record<string, string> {
  const raw = requireRecord(value, label)
  const labels: Record<string, string> = {}
  for (const [key, entry] of Object.entries(raw)) {
    if (typeof entry !== 'string') throw new Error(`${label}.${key} 必须是字符串`)
    labels[key] = entry
  }
  return labels
}

function serviceEnvironment(service: UnknownRecord, serviceName: string): UnknownRecord {
  return requireRecord(service.environment, `services.${serviceName}.environment`)
}

function validatePostgresEndpoint(backendEnvironment: UnknownRecord): void {
  const postgresUrl = requireString(
    backendEnvironment.POSTGRES_URL,
    'services.convex-backend.environment.POSTGRES_URL',
  )
  let parsed: URL
  try {
    parsed = new URL(postgresUrl)
  } catch {
    throw new Error('Convex POSTGRES_URL 不是合法 URL')
  }
  if (
    (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') ||
    parsed.hostname !== 'convex-postgres'
  ) {
    throw new Error('Convex PostgreSQL 必须使用 compose 服务 convex-postgres')
  }
}

function validateS3Endpoint(backendEnvironment: UnknownRecord): void {
  const endpoint = requireString(
    backendEnvironment.S3_ENDPOINT_URL,
    'services.convex-backend.environment.S3_ENDPOINT_URL',
  )
  let parsed: URL
  try {
    parsed = new URL(endpoint)
  } catch {
    throw new Error('Convex S3_ENDPOINT_URL 不是合法 URL')
  }
  if (
    parsed.protocol !== 'http:' ||
    parsed.hostname !== 'minio' ||
    parsed.port !== '9000' ||
    (parsed.pathname !== '' && parsed.pathname !== '/') ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.username !== '' ||
    parsed.password !== ''
  ) {
    throw new Error('Convex S3 endpoint 必须是 http://minio:9000')
  }
}

function validateWorkerSecret(
  backendEnvironment: UnknownRecord,
  webEnvironment: UnknownRecord,
): void {
  const backendSecret = requireString(
    backendEnvironment.PRINT_WORKER_HMAC_SECRET,
    'services.convex-backend.environment.PRINT_WORKER_HMAC_SECRET',
  )
  const webSecret = requireString(
    webEnvironment.PRINT_WORKER_HMAC_SECRET,
    'services.web.environment.PRINT_WORKER_HMAC_SECRET',
  )
  if (backendSecret !== webSecret) {
    throw new Error('Web 与 Convex 的 PRINT_WORKER_HMAC_SECRET 必须一致')
  }
  if (new TextEncoder().encode(backendSecret).byteLength < 32) {
    throw new Error('PRINT_WORKER_HMAC_SECRET 必须至少 32 bytes')
  }
}

export function parseResetArgs(argv: readonly string[]): ResetArgs {
  const result: ResetArgs = {
    yes: false,
    dryRun: false,
    startWeb: true,
    discardDeploymentEnv: false,
    help: false,
  }
  for (const arg of argv) {
    switch (arg) {
      case '--yes':
      case '-y':
        result.yes = true
        break
      case '--dry-run':
        result.dryRun = true
        break
      case '--no-web':
        result.startWeb = false
        break
      case '--discard-deployment-env':
        result.discardDeploymentEnv = true
        break
      case '--help':
      case '-h':
        result.help = true
        break
      default:
        throw new Error(`未知 reset 参数：${arg}`)
    }
  }
  return result
}

export function assertDevelopmentEnvironment(env: NodeJS.ProcessEnv): void {
  for (const name of ENVIRONMENT_MARKERS) {
    const raw = env[name]
    if (raw === undefined || raw.trim() === '') continue
    const value = raw.trim().toLowerCase()
    if (!SAFE_ENVIRONMENT_VALUES.has(value)) {
      throw new Error(`${name} 不是允许 reset 的本地开发/测试环境`)
    }
  }
}

export function validateDockerEndpoint(endpoint: string | undefined): void {
  if (endpoint === undefined || endpoint === '') return
  if (endpoint !== endpoint.trim()) {
    throw new Error('DOCKER_HOST 只允许本地 unix socket 或本机 npipe')
  }

  const lower = endpoint.toLowerCase()
  if (lower.startsWith('unix://')) {
    const path = endpoint.slice('unix://'.length)
    if (
      path.startsWith('/') &&
      path.length > 1 &&
      !/[\0\r\n?#]/.test(path)
    ) {
      return
    }
  }

  const npipePrefix = 'npipe:////./pipe/'
  if (lower.startsWith(npipePrefix)) {
    const pipe = endpoint.slice(npipePrefix.length)
    if (pipe.length > 0 && !/[\\/?#\s\0]/.test(pipe)) return
  }

  throw new Error('DOCKER_HOST 只允许本地 unix socket 或本机 npipe')
}

export function validateResetComposeConfig(
  config: unknown,
  workspace: string,
  expectedProject?: string,
): ResetComposeTarget {
  const root = requireRecord(config, 'Compose config')
  const project = requireString(root.name, 'Compose project name')
  if (!/^synie(?:[-_][a-z0-9](?:[a-z0-9_-]*[a-z0-9])?)?$/.test(project)) {
    throw new Error('reset 只允许 project 名 synie 或 synie-/synie_ 前缀')
  }
  if (expectedProject !== undefined && project !== expectedProject) {
    throw new Error(`Compose project ${project} 与本地凭据 project 不一致`)
  }

  const normalized = normalizedWorkspace(workspace)
  const services = requireRecord(root.services, 'Compose services')
  const web = requireRecord(services.web, 'services.web')
  const webBuild = requireRecord(web.build, 'services.web.build')
  const webBuildContext = requireString(webBuild.context, 'services.web.build.context')
  if (resolve(webBuildContext) !== normalized) {
    throw new Error('Compose Web build context 不属于当前 workspace')
  }

  const backend = requireRecord(services['convex-backend'], 'services.convex-backend')
  const backendEnvironment = serviceEnvironment(backend, 'convex-backend')
  const webEnvironment = serviceEnvironment(web, 'web')
  validatePostgresEndpoint(backendEnvironment)
  validateS3Endpoint(backendEnvironment)
  validateWorkerSecret(backendEnvironment, webEnvironment)

  const rawVolumes = requireRecord(root.volumes, 'Compose volumes')
  const actualLogicalNames = Object.keys(rawVolumes).sort()
  const expectedLogicalNames = RESET_VOLUME_SPECS.map((spec) => spec.logical).sort()
  if (JSON.stringify(actualLogicalNames) !== JSON.stringify(expectedLogicalNames)) {
    throw new Error(
      `Compose 必须且只能声明 reset 三卷：${expectedLogicalNames.join('、')}`,
    )
  }

  const volumes: ResetVolumeTarget[] = RESET_VOLUME_SPECS.map((spec) => {
    const volume = requireRecord(rawVolumes[spec.logical], `volumes.${spec.logical}`)
    if (volume.external !== undefined && volume.external !== false) {
      throw new Error(`reset 拒绝 external volume：${spec.logical}`)
    }
    const resolvedName = requireString(volume.name, `volumes.${spec.logical}.name`)
    const expectedName = `${project}_${spec.logical}`
    if (resolvedName !== expectedName) {
      throw new Error(`reset volume ${spec.logical} 必须使用 Compose 默认项目限定名`)
    }
    return { ...spec, resolved: resolvedName }
  })

  const references = new Map<ResetVolumeLogicalName, Array<{ service: string; target: string }>>()
  for (const spec of RESET_VOLUME_SPECS) references.set(spec.logical, [])

  for (const [serviceName, rawService] of Object.entries(services)) {
    const service = requireRecord(rawService, `services.${serviceName}`)
    if (service.volumes === undefined || service.volumes === null) continue
    if (!Array.isArray(service.volumes)) {
      throw new Error(`services.${serviceName}.volumes 必须是数组`)
    }
    for (const [index, rawMount] of service.volumes.entries()) {
      const mount = requireRecord(rawMount, `services.${serviceName}.volumes[${index}]`)
      if (mount.type !== 'volume') continue
      const source = requireString(
        mount.source,
        `services.${serviceName}.volumes[${index}].source`,
      )
      if (!references.has(source as ResetVolumeLogicalName)) {
        throw new Error(`reset 拒绝未纳入策略的 volume mount：${source}`)
      }
      if (mount.read_only === true) {
        throw new Error(`reset 数据卷不能只读挂载：${source}`)
      }
      const target = requireString(
        mount.target,
        `services.${serviceName}.volumes[${index}].target`,
      )
      references.get(source as ResetVolumeLogicalName)!.push({ service: serviceName, target })
    }
  }

  for (const spec of RESET_VOLUME_SPECS) {
    const mounts = references.get(spec.logical)!
    if (
      mounts.length !== 1 ||
      mounts[0]!.service !== spec.service ||
      mounts[0]!.target !== spec.target
    ) {
      throw new Error(
        `${spec.logical} 只能挂载到 ${spec.service}:${spec.target}`,
      )
    }
  }

  return { project, volumes }
}

export function validateResetVolumeInspections(
  target: ResetComposeTarget,
  inspections: readonly DockerVolumeInspection[],
): void {
  if (inspections.length !== target.volumes.length) {
    throw new Error('Docker 中的 reset volume 数量与 Compose 计划不一致')
  }
  const expected = new Map(target.volumes.map((volume) => [volume.resolved, volume]))
  const seen = new Set<string>()

  for (const [index, rawInspection] of inspections.entries()) {
    const inspection = requireRecord(rawInspection, `volume inspect[${index}]`)
    const name = requireString(inspection.Name, `volume inspect[${index}].Name`)
    const volume = expected.get(name)
    if (!volume || seen.has(name)) {
      throw new Error(`Docker volume inspect 包含非计划卷或重复卷：${name}`)
    }
    seen.add(name)
    const labels = labelsFrom(inspection.Labels, `volume ${name} labels`)
    if (labels['com.docker.compose.project'] !== target.project) {
      throw new Error(`Docker volume ${name} 的 Compose project label 不匹配`)
    }
    if (labels['com.docker.compose.volume'] !== volume.logical) {
      throw new Error(`Docker volume ${name} 的 logical volume label 不匹配`)
    }
  }

  if (seen.size !== expected.size) {
    throw new Error('Docker 缺少计划中的 reset volume')
  }
}

export function validateNoForeignResetVolumeMounts(
  target: ResetComposeTarget,
  workspace: string,
  containers: readonly DockerContainerInspection[],
): void {
  const normalized = normalizedWorkspace(workspace)
  const expectedConfig = join(normalized, 'compose.yaml')
  const volumes = new Map(target.volumes.map((volume) => [volume.resolved, volume]))

  for (const [containerIndex, rawContainer] of containers.entries()) {
    const container = requireRecord(rawContainer, `container inspect[${containerIndex}]`)
    const containerName =
      typeof container.Name === 'string' && container.Name.length > 0
        ? container.Name.replace(/^\//, '')
        : `#${containerIndex}`
    if (container.Mounts === undefined || container.Mounts === null) continue
    if (!Array.isArray(container.Mounts)) {
      throw new Error(`container ${containerName} Mounts 必须是数组`)
    }

    for (const [mountIndex, rawMount] of container.Mounts.entries()) {
      const mount = requireRecord(
        rawMount,
        `container ${containerName} Mounts[${mountIndex}]`,
      )
      if (mount.Type !== 'volume' || typeof mount.Name !== 'string') continue
      const volume = volumes.get(mount.Name)
      if (!volume) continue

      const config = requireRecord(container.Config, `container ${containerName} Config`)
      const labels = labelsFrom(config.Labels, `container ${containerName} labels`)
      const configFiles = (labels['com.docker.compose.project.config_files'] ?? '')
        .split(',')
        .map((path) => path.trim())
        .filter(Boolean)
        .map((path) => resolve(path))
      const workingDirectory = labels['com.docker.compose.project.working_dir']
      const destination = requireString(
        mount.Destination,
        `container ${containerName} volume destination`,
      )

      if (
        labels['com.docker.compose.project'] !== target.project ||
        labels['com.docker.compose.service'] !== volume.service ||
        !workingDirectory ||
        resolve(workingDirectory) !== normalized ||
        !configFiles.includes(expectedConfig) ||
        destination !== volume.target
      ) {
        throw new Error(
          `volume ${volume.resolved} 被非当前 workspace/服务容器 ${containerName} 挂载`,
        )
      }
    }
  }
}

export function validateResetDockerState(
  target: ResetComposeTarget,
  workspace: string,
  volumes: readonly DockerVolumeInspection[],
  containers: readonly DockerContainerInspection[],
): void {
  validateResetVolumeInspections(target, volumes)
  validateNoForeignResetVolumeMounts(target, workspace, containers)
}
