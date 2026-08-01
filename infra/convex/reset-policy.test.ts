import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import {
  assertDevelopmentEnvironment,
  parseResetArgs,
  validateDockerEndpoint,
  validateNoForeignResetVolumeMounts,
  validateResetComposeConfig,
  validateResetDockerState,
  validateResetVolumeInspections,
  type ResetComposeTarget,
} from './reset-policy.ts'

const workspace = '/workspace/synie'
const workerSecret = '0123456789abcdef0123456789abcdef'

function validConfig(project = 'synie-reset-test'): Record<string, unknown> {
  return {
    name: project,
    volumes: {
      'convex-postgres': { name: `${project}_convex-postgres` },
      'synie-minio': { name: `${project}_synie-minio` },
      'convex-backend-data': { name: `${project}_convex-backend-data` },
    },
    services: {
      'convex-postgres': {
        volumes: [
          {
            type: 'volume',
            source: 'convex-postgres',
            target: '/var/lib/postgresql/data',
            volume: {},
          },
        ],
      },
      minio: {
        volumes: [
          { type: 'volume', source: 'synie-minio', target: '/data', volume: {} },
        ],
      },
      'convex-backend': {
        environment: {
          POSTGRES_URL:
            'postgresql://convex:local-password@convex-postgres:5432',
          S3_ENDPOINT_URL: 'http://minio:9000',
          PRINT_WORKER_HMAC_SECRET: workerSecret,
        },
        volumes: [
          {
            type: 'volume',
            source: 'convex-backend-data',
            target: '/convex/data',
            volume: {},
          },
        ],
      },
      web: {
        build: { context: workspace },
        environment: { PRINT_WORKER_HMAC_SECRET: workerSecret },
      },
      'minio-init': {
        volumes: [
          {
            type: 'bind',
            source: join(workspace, 'infra/convex/minio-init.sh'),
            target: '/bootstrap/minio-init.sh',
          },
        ],
      },
    },
  }
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function configServices(config: Record<string, unknown>): Record<string, any> {
  return config.services as Record<string, any>
}

function configVolumes(config: Record<string, unknown>): Record<string, any> {
  return config.volumes as Record<string, any>
}

function validTarget(): ResetComposeTarget {
  return validateResetComposeConfig(validConfig(), workspace, 'synie-reset-test')
}

function validVolumeInspections(target = validTarget()) {
  return target.volumes.map((volume) => ({
    Name: volume.resolved,
    Labels: {
      'com.docker.compose.project': target.project,
      'com.docker.compose.volume': volume.logical,
    },
  }))
}

type OwnedContainer = {
  Name: string
  Config: { Labels: Record<string, string> }
  Mounts: Array<{ Type: string; Name: string; Destination: string }>
}

function ownedContainer(
  target: ResetComposeTarget,
  logical: ResetComposeTarget['volumes'][number]['logical'],
): OwnedContainer {
  const volume = target.volumes.find((entry) => entry.logical === logical)!
  return {
    Name: `/${target.project}-${volume.service}-1`,
    Config: {
      Labels: {
        'com.docker.compose.project': target.project,
        'com.docker.compose.service': volume.service,
        'com.docker.compose.project.config_files': join(workspace, 'compose.yaml'),
        'com.docker.compose.project.working_dir': workspace,
      },
    },
    Mounts: [
      {
        Type: 'volume',
        Name: volume.resolved,
        Destination: volume.target,
      },
    ],
  }
}

describe('parseResetArgs', () => {
  test('defaults to interactive reset with Web restart', () => {
    expect(parseResetArgs([])).toEqual({
      yes: false,
      dryRun: false,
      startWeb: true,
      discardDeploymentEnv: false,
      help: false,
    })
  })

  test('accepts long and short flags in any order', () => {
    expect(parseResetArgs(['--dry-run', '-y', '--no-web', '--discard-deployment-env', '-h'])).toEqual({
      yes: true,
      dryRun: true,
      startWeb: false,
      discardDeploymentEnv: true,
      help: true,
    })
    expect(parseResetArgs(['--yes', '--help'])).toMatchObject({ yes: true, help: true })
  })

  test('is idempotent for duplicate supported flags', () => {
    expect(parseResetArgs(['-y', '--yes', '--dry-run', '--dry-run']).yes).toBe(true)
  })

  test('rejects positional, combined, separator, and unknown arguments', () => {
    for (const arg of ['project', '-yh', '--', '--force', '--no-web=true']) {
      expect(() => parseResetArgs([arg])).toThrow(`未知 reset 参数：${arg}`)
    }
  })
})

describe('assertDevelopmentEnvironment', () => {
  test('allows unset and explicit local development/test markers', () => {
    expect(() => assertDevelopmentEnvironment({})).not.toThrow()
    expect(() =>
      assertDevelopmentEnvironment({
        NODE_ENV: ' Development ',
        SYNIE_ENV: 'LOCAL',
        APP_ENV: 'test',
      }),
    ).not.toThrow()
  })

  test('rejects production, staging, and unknown environment markers', () => {
    for (const [name, value] of [
      ['NODE_ENV', 'production'],
      ['SYNIE_ENV', 'prod'],
      ['APP_ENV', 'staging'],
      ['APP_ENV', 'preview'],
    ] as const) {
      expect(() => assertDevelopmentEnvironment({ [name]: value })).toThrow(name)
    }
  })

  test('one unsafe marker overrides otherwise safe markers', () => {
    expect(() =>
      assertDevelopmentEnvironment({ NODE_ENV: 'test', SYNIE_ENV: 'production' }),
    ).toThrow('SYNIE_ENV')
  })
})

describe('validateDockerEndpoint', () => {
  test('accepts the implicit local Docker endpoint and canonical local transports', () => {
    for (const endpoint of [
      undefined,
      '',
      'unix:///var/run/docker.sock',
      'unix:///run/user/1000/docker.sock',
      'npipe:////./pipe/docker_engine',
    ]) {
      expect(() => validateDockerEndpoint(endpoint)).not.toThrow()
    }
  })

  test('rejects remote, relative, malformed, or whitespace-padded endpoints', () => {
    for (const endpoint of [
      'tcp://127.0.0.1:2375',
      'ssh://docker@example.test',
      'https://docker.example.test',
      'unix://relative.sock',
      'unix:///',
      'unix:///var/run/docker.sock?x=1',
      'npipe:////server/pipe/docker_engine',
      ' npipe:////./pipe/docker_engine',
    ]) {
      expect(() => validateDockerEndpoint(endpoint)).toThrow('DOCKER_HOST')
    }
  })
})

describe('validateResetComposeConfig', () => {
  test('returns the exact ordered project-scoped reset target', () => {
    expect(validateResetComposeConfig(validConfig(), workspace)).toEqual({
      project: 'synie-reset-test',
      volumes: [
        {
          logical: 'convex-postgres',
          resolved: 'synie-reset-test_convex-postgres',
          service: 'convex-postgres',
          target: '/var/lib/postgresql/data',
        },
        {
          logical: 'synie-minio',
          resolved: 'synie-reset-test_synie-minio',
          service: 'minio',
          target: '/data',
        },
        {
          logical: 'convex-backend-data',
          resolved: 'synie-reset-test_convex-backend-data',
          service: 'convex-backend',
          target: '/convex/data',
        },
      ],
    })
  })

  test('allows only synie, synie-, or synie_ project names', () => {
    for (const project of ['synie', 'synie-local', 'synie_reset2']) {
      expect(() => validateResetComposeConfig(validConfig(project), workspace)).not.toThrow()
    }
    for (const project of [
      'production',
      'synieproduction',
      'Synie-local',
      'synie-',
      'synie_',
      'synie--local',
    ]) {
      expect(() => validateResetComposeConfig(validConfig(project), workspace)).toThrow(
        'reset 只允许 project 名',
      )
    }
  })

  test('rejects a credential project mismatch', () => {
    expect(() =>
      validateResetComposeConfig(validConfig(), workspace, 'synie-another'),
    ).toThrow('与本地凭据 project 不一致')
  })

  test('requires Web build context to be the current workspace', () => {
    const config = validConfig()
    configServices(config).web.build.context = '/workspace/another'
    expect(() => validateResetComposeConfig(config, workspace)).toThrow(
      'Web build context 不属于当前 workspace',
    )
    expect(() => validateResetComposeConfig(validConfig(), '/')).toThrow(
      'workspace 不能是文件系统根目录',
    )
  })

  test('requires exactly the three internal non-external volumes', () => {
    const missing = validConfig()
    delete configVolumes(missing)['synie-minio']
    expect(() => validateResetComposeConfig(missing, workspace)).toThrow(
      '必须且只能声明 reset 三卷',
    )

    const extra = validConfig()
    configVolumes(extra).cache = { name: 'synie-reset-test_cache' }
    expect(() => validateResetComposeConfig(extra, workspace)).toThrow(
      '必须且只能声明 reset 三卷',
    )

    const external = validConfig()
    configVolumes(external)['synie-minio'].external = true
    expect(() => validateResetComposeConfig(external, workspace)).toThrow('external volume')
  })

  test('requires default project-qualified resolved volume names', () => {
    const config = validConfig()
    configVolumes(config)['synie-minio'].name = 'shared-minio'
    expect(() => validateResetComposeConfig(config, workspace)).toThrow(
      '必须使用 Compose 默认项目限定名',
    )
  })

  test('requires Convex to use the internal PostgreSQL and MinIO services', () => {
    const remotePostgres = validConfig()
    configServices(remotePostgres)['convex-backend'].environment.POSTGRES_URL =
      'postgresql://user:password@db.example.test:5432/synie'
    expect(() => validateResetComposeConfig(remotePostgres, workspace)).toThrow(
      '必须使用 compose 服务 convex-postgres',
    )

    const nonPostgres = validConfig()
    configServices(nonPostgres)['convex-backend'].environment.POSTGRES_URL =
      'https://convex-postgres:5432'
    expect(() => validateResetComposeConfig(nonPostgres, workspace)).toThrow(
      '必须使用 compose 服务 convex-postgres',
    )

    const remoteS3 = validConfig()
    configServices(remoteS3)['convex-backend'].environment.S3_ENDPOINT_URL =
      'http://minio.example.test:9000'
    expect(() => validateResetComposeConfig(remoteS3, workspace)).toThrow(
      '必须是 http://minio:9000',
    )

    const pathS3 = validConfig()
    configServices(pathS3)['convex-backend'].environment.S3_ENDPOINT_URL =
      'http://minio:9000/bucket'
    expect(() => validateResetComposeConfig(pathS3, workspace)).toThrow(
      '必须是 http://minio:9000',
    )
  })

  test('requires an equal HMAC secret of at least 32 bytes without exposing it', () => {
    const mismatch = validConfig()
    configServices(mismatch).web.environment.PRINT_WORKER_HMAC_SECRET =
      'different-secret-that-is-at-least-32-bytes'
    expect(() => validateResetComposeConfig(mismatch, workspace)).toThrow(
      'PRINT_WORKER_HMAC_SECRET 必须一致',
    )

    const short = validConfig()
    configServices(short)['convex-backend'].environment.PRINT_WORKER_HMAC_SECRET = 'short'
    configServices(short).web.environment.PRINT_WORKER_HMAC_SECRET = 'short'
    expect(() => validateResetComposeConfig(short, workspace)).toThrow('至少 32 bytes')

    const unicode = validConfig()
    const multiByteSecret = '密'.repeat(11)
    configServices(unicode)['convex-backend'].environment.PRINT_WORKER_HMAC_SECRET =
      multiByteSecret
    configServices(unicode).web.environment.PRINT_WORKER_HMAC_SECRET = multiByteSecret
    expect(() => validateResetComposeConfig(unicode, workspace)).not.toThrow()
  })

  test('requires each data volume at exactly its expected service path', () => {
    const wrongService = validConfig()
    configServices(wrongService).web.volumes = [
      { type: 'volume', source: 'synie-minio', target: '/data' },
    ]
    expect(() => validateResetComposeConfig(wrongService, workspace)).toThrow(
      'synie-minio 只能挂载到 minio:/data',
    )

    const wrongPath = validConfig()
    configServices(wrongPath).minio.volumes[0].target = '/different'
    expect(() => validateResetComposeConfig(wrongPath, workspace)).toThrow(
      'synie-minio 只能挂载到 minio:/data',
    )

    const missingMount = validConfig()
    configServices(missingMount).minio.volumes = []
    expect(() => validateResetComposeConfig(missingMount, workspace)).toThrow(
      'synie-minio 只能挂载到 minio:/data',
    )

    const readOnly = validConfig()
    configServices(readOnly).minio.volumes[0].read_only = true
    expect(() => validateResetComposeConfig(readOnly, workspace)).toThrow('不能只读挂载')

    const anonymous = validConfig()
    configServices(anonymous).web.volumes = [
      { type: 'volume', source: 'anonymous-cache', target: '/cache' },
    ]
    expect(() => validateResetComposeConfig(anonymous, workspace)).toThrow(
      '拒绝未纳入策略的 volume mount',
    )
  })

  test('fails closed for malformed config shapes', () => {
    expect(() => validateResetComposeConfig(null, workspace)).toThrow('Compose config')
    expect(() => validateResetComposeConfig({ name: 'synie-test' }, workspace)).toThrow(
      'Compose services',
    )
    const malformed = validConfig()
    configServices(malformed).minio.volumes = 'synie-minio:/data'
    expect(() => validateResetComposeConfig(malformed, workspace)).toThrow('必须是数组')
  })
})

describe('validateResetVolumeInspections', () => {
  test('accepts exactly the three project/logical labeled volumes', () => {
    const target = validTarget()
    expect(() =>
      validateResetVolumeInspections(target, validVolumeInspections(target)),
    ).not.toThrow()
  })

  test('rejects missing, extra, duplicate, or renamed volume inspections', () => {
    const target = validTarget()
    const valid = validVolumeInspections(target)
    expect(() => validateResetVolumeInspections(target, valid.slice(0, 2))).toThrow(
      '数量与 Compose 计划不一致',
    )
    expect(() =>
      validateResetVolumeInspections(target, [...valid, { ...valid[0] }]),
    ).toThrow('数量与 Compose 计划不一致')
    expect(() =>
      validateResetVolumeInspections(target, [valid[0]!, valid[0]!, valid[2]!]),
    ).toThrow('非计划卷或重复卷')
    expect(() =>
      validateResetVolumeInspections(target, [
        { ...valid[0], Name: 'synie-reset-test_other' },
        valid[1]!,
        valid[2]!,
      ]),
    ).toThrow('非计划卷或重复卷')
  })

  test('rejects missing or mismatched Compose ownership labels', () => {
    const target = validTarget()
    const wrongProject = clone(validVolumeInspections(target))
    wrongProject[0]!.Labels['com.docker.compose.project'] = 'synie-foreign'
    expect(() => validateResetVolumeInspections(target, wrongProject)).toThrow(
      'project label 不匹配',
    )

    const wrongLogical = clone(validVolumeInspections(target))
    wrongLogical[0]!.Labels['com.docker.compose.volume'] = 'synie-minio'
    expect(() => validateResetVolumeInspections(target, wrongLogical)).toThrow(
      'logical volume label 不匹配',
    )

    const noLabels = clone(validVolumeInspections(target))
    noLabels[0]!.Labels = null as any
    expect(() => validateResetVolumeInspections(target, noLabels)).toThrow('labels')
  })
})

describe('validateNoForeignResetVolumeMounts', () => {
  test('accepts stopped stacks, owned mounts, and unrelated containers', () => {
    const target = validTarget()
    expect(() => validateNoForeignResetVolumeMounts(target, workspace, [])).not.toThrow()
    expect(() =>
      validateNoForeignResetVolumeMounts(target, workspace, [
        ...target.volumes.map((volume) => ownedContainer(target, volume.logical)),
        {
          Name: '/unrelated',
          Config: { Labels: {} },
          Mounts: [{ Type: 'volume', Name: 'some-other-volume', Destination: '/data' }],
        },
      ]),
    ).not.toThrow()
  })

  test('rejects a target volume mounted by a non-Compose container', () => {
    const target = validTarget()
    const container = ownedContainer(target, 'synie-minio')
    container.Config.Labels = {}
    expect(() =>
      validateNoForeignResetVolumeMounts(target, workspace, [container]),
    ).toThrow('被非当前 workspace/服务容器')
  })

  test('rejects mismatched project, service, workspace, config file, or destination', () => {
    const target = validTarget()
    const mutations: Array<(container: OwnedContainer) => void> = [
      (container) => {
        container.Config.Labels['com.docker.compose.project'] = 'synie-foreign'
      },
      (container) => {
        container.Config.Labels['com.docker.compose.service'] = 'web'
      },
      (container) => {
        container.Config.Labels['com.docker.compose.project.working_dir'] =
          '/workspace/foreign'
      },
      (container) => {
        container.Config.Labels['com.docker.compose.project.config_files'] =
          '/workspace/foreign/compose.yaml'
      },
      (container) => {
        container.Mounts[0]!.Destination = '/foreign'
      },
    ]
    for (const mutate of mutations) {
      const container = ownedContainer(target, 'convex-postgres')
      mutate(container)
      expect(() =>
        validateNoForeignResetVolumeMounts(target, workspace, [container]),
      ).toThrow('被非当前 workspace/服务容器')
    }
  })

  test('accepts the expected compose file among multiple config files', () => {
    const target = validTarget()
    const container = ownedContainer(target, 'convex-backend-data')
    container.Config.Labels['com.docker.compose.project.config_files'] =
      `/workspace/override.yaml,${join(workspace, 'compose.yaml')}`
    expect(() =>
      validateNoForeignResetVolumeMounts(target, workspace, [container]),
    ).not.toThrow()
  })

  test('combined Docker state validator applies labels and mount ownership', () => {
    const target = validTarget()
    expect(() =>
      validateResetDockerState(
        target,
        workspace,
        validVolumeInspections(target),
        target.volumes.map((volume) => ownedContainer(target, volume.logical)),
      ),
    ).not.toThrow()

    const foreign = ownedContainer(target, 'synie-minio')
    foreign.Config.Labels['com.docker.compose.project.working_dir'] = '/tmp/foreign'
    expect(() =>
      validateResetDockerState(
        target,
        workspace,
        validVolumeInspections(target),
        [foreign],
      ),
    ).toThrow('被非当前 workspace/服务容器')
  })
})
