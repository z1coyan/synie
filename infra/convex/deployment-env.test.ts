import { describe, expect, test } from 'bun:test'
import {
  buildLocalDeploymentEnv,
  localDeploymentInputs,
  type DeploymentComposeConfig,
  type LocalDeploymentInputs,
} from './deployment-env.ts'

const hmac = 'h'.repeat(32)

function composeConfig(overrides: {
  backendHmac?: string
  webHmac?: string
} = {}): DeploymentComposeConfig {
  return {
    services: {
      'convex-backend': {
        environment: {
          PRINT_WORKER_URL: 'http://web:3000',
          PRINT_WORKER_HMAC_SECRET: overrides.backendHmac ?? hmac,
        },
      },
      web: {
        environment: {
          PRINT_WORKER_HMAC_SECRET: overrides.webHmac ?? hmac,
        },
      },
      minio: {
        environment: {
          MINIO_ROOT_USER: 'local-access',
          MINIO_ROOT_PASSWORD: 'local-secret',
        },
      },
    },
  }
}

const inputs: LocalDeploymentInputs = {
  siteUrl: 'http://100.64.0.1:3000',
  s3InternalEndpoint: 'http://minio:9000',
  s3PublicEndpoint: 'http://100.64.0.1:9000',
  s3Region: 'us-east-1',
  s3AccessKeyId: 'local-access',
  s3SecretAccessKey: 'local-secret',
  productFilesBucket: 'synie-product-files',
  printWorkerUrl: 'http://web:3000',
  printWorkerHmacSecret: hmac,
}

describe('localDeploymentInputs', () => {
  test('从当前公开 origin 与 Compose resolved secret 派生 deployment 配置', () => {
    expect(
      localDeploymentInputs(composeConfig(), {
        VITE_SITE_URL: 'http://100.64.0.1:23000/',
        SYNIE_S3_PUBLIC_ENDPOINT: 'http://100.64.0.1:29000/',
      }),
    ).toEqual({
      siteUrl: 'http://100.64.0.1:23000',
      s3InternalEndpoint: 'http://minio:9000',
      s3PublicEndpoint: 'http://100.64.0.1:29000',
      s3Region: 'us-east-1',
      s3AccessKeyId: 'local-access',
      s3SecretAccessKey: 'local-secret',
      productFilesBucket: 'synie-product-files',
      printWorkerUrl: 'http://web:3000',
      printWorkerHmacSecret: hmac,
    })
  })

  test('拒绝 Web 与 Convex 不一致或过短的 HMAC', () => {
    expect(() =>
      localDeploymentInputs(composeConfig({ webHmac: 'x'.repeat(32) }), {}),
    ).toThrow('不一致')
    expect(() =>
      localDeploymentInputs(
        composeConfig({ backendHmac: 'short', webHmac: 'short' }),
        {},
      ),
    ).toThrow('至少 32 bytes')
  })

  test('拒绝带路径的 SITE_URL', () => {
    expect(() =>
      localDeploymentInputs(composeConfig(), {
        VITE_SITE_URL: 'http://localhost:3000/setup',
      }),
    ).toThrow('只能包含 origin')
  })
})

describe('buildLocalDeploymentEnv', () => {
  test('保留未知 deployment 配置并规范覆盖本地托管值', () => {
    const source = buildLocalDeploymentEnv(
      `BETTER_AUTH_SECRET=${'b'.repeat(64)}\nCUSTOM_PROVIDER_TOKEN="opaque value"\nSITE_URL=http://old.invalid\n`,
      inputs,
      { env: {} },
    )
    expect(source).toContain(`BETTER_AUTH_SECRET="${'b'.repeat(64)}"`)
    expect(source).toContain('CUSTOM_PROVIDER_TOKEN="opaque value"')
    expect(source).toContain('SITE_URL="http://100.64.0.1:3000"')
    expect(source).not.toContain('old.invalid')
  })

  test('reset 会轮换 Better Auth secret 且不把值输出为旧值', () => {
    const oldSecret = 'b'.repeat(64)
    const source = buildLocalDeploymentEnv(
      `BETTER_AUTH_SECRET=${oldSecret}\n`,
      inputs,
      { rotateBetterAuthSecret: true, env: {} },
    )
    expect(source).not.toContain(oldSecret)
    const line = source.split('\n').find((item) => item.startsWith('BETTER_AUTH_SECRET='))
    expect(line).toBeDefined()
    expect(JSON.parse(line!.slice(line!.indexOf('=') + 1))).toHaveLength(64)
  })

  test('OCR 凭据必须成对，并仅在 deployment 尚无值时补入', () => {
    expect(() =>
      buildLocalDeploymentEnv('', inputs, {
        env: { SYNIE_OCR_ACCESS_KEY_ID: 'id-only' },
      }),
    ).toThrow('必须成对')

    const source = buildLocalDeploymentEnv('', inputs, {
      env: {
        SYNIE_OCR_ACCESS_KEY_ID: 'ocr-id',
        SYNIE_OCR_ACCESS_KEY_SECRET: 'ocr-secret',
      },
    })
    expect(source).toContain('SYNIE_OCR_ACCESS_KEY_ID="ocr-id"')
    expect(source).toContain('SYNIE_OCR_ACCESS_KEY_SECRET="ocr-secret"')

    const preserved = buildLocalDeploymentEnv(
      'SYNIE_OCR_ACCESS_KEY_ID="existing-id"\nSYNIE_OCR_ACCESS_KEY_SECRET="existing-secret"\n',
      inputs,
      {
        env: {
          SYNIE_OCR_ACCESS_KEY_ID: 'new-id',
          SYNIE_OCR_ACCESS_KEY_SECRET: 'new-secret',
        },
      },
    )
    expect(preserved).toContain('SYNIE_OCR_ACCESS_KEY_ID="existing-id"')
    expect(preserved).toContain('SYNIE_OCR_ACCESS_KEY_SECRET="existing-secret"')
    expect(preserved).not.toContain('new-secret')
    expect(() =>
      buildLocalDeploymentEnv('SYNIE_OCR_ACCESS_KEY_ID=orphan\n', inputs),
    ).toThrow('捕获的 OCR AccessKey 必须成对')
  })

  test('拒绝无法无损恢复的捕获格式与重复变量', () => {
    expect(() => buildLocalDeploymentEnv('not-an-assignment\n', inputs)).toThrow(
      '输出格式无效',
    )
    expect(() =>
      buildLocalDeploymentEnv('DUP=one\nDUP=two\n', inputs),
    ).toThrow('重复变量')
  })
})
