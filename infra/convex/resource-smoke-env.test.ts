import { describe, expect, test } from 'bun:test'
import { hostWebEnv } from './host-web-env.ts'
import { resourceSmokeHostWebEnv } from './resource-smoke-env.ts'

describe('hostWebEnv', () => {
  test('宿主 TanStack SSR 使用 self-hosted 地址且保留既有 public VITE 地址', () => {
    const result = hostWebEnv({
      CONVEX_SELF_HOSTED_URL: 'http://127.0.0.1:3210',
      CONVEX_SELF_HOSTED_SITE_URL: 'http://127.0.0.1:3211',
      VITE_CONVEX_URL: 'http://100.64.0.1:3210',
      VITE_CONVEX_SITE_URL: 'http://100.64.0.1:3211',
      VITE_SITE_URL: 'http://100.64.0.1:3000',
      SYNIE_CONVEX_INTERNAL_URL: 'http://convex-backend:3210',
      SYNIE_CONVEX_INTERNAL_SITE_URL: 'http://convex-backend:3211',
    })

    expect(result).toMatchObject({
      CONVEX_SELF_HOSTED_URL: 'http://127.0.0.1:3210',
      CONVEX_SELF_HOSTED_SITE_URL: 'http://127.0.0.1:3211',
      VITE_CONVEX_URL: 'http://100.64.0.1:3210',
      VITE_CONVEX_SITE_URL: 'http://100.64.0.1:3211',
      VITE_SITE_URL: 'http://100.64.0.1:3000',
      SYNIE_CONVEX_INTERNAL_URL: 'http://127.0.0.1:3210',
      SYNIE_CONVEX_INTERNAL_SITE_URL: 'http://127.0.0.1:3211',
    })
  })
})

describe('resourceSmokeHostWebEnv', () => {
  test('宿主机 Vite 覆盖 base env 中仅容器可达的 SSR 地址', () => {
    const baseEnv: NodeJS.ProcessEnv = {
      SYNIE_CONVEX_INTERNAL_URL: 'http://convex-backend:3210',
      SYNIE_CONVEX_INTERNAL_SITE_URL: 'http://convex-backend:3211',
      UNRELATED_VALUE: 'preserved',
    }

    const result = resourceSmokeHostWebEnv(baseEnv, {
      convexPort: '47210',
      sitePort: '47211',
      webPort: '44303',
    })

    expect(result).toMatchObject({
      SYNIE_CONVEX_INTERNAL_URL: 'http://127.0.0.1:47210',
      SYNIE_CONVEX_INTERNAL_SITE_URL: 'http://127.0.0.1:47211',
      VITE_CONVEX_URL: 'http://127.0.0.1:47210',
      VITE_CONVEX_SITE_URL: 'http://127.0.0.1:47211',
      VITE_SITE_URL: 'http://127.0.0.1:44303',
      WEB_HOST: '127.0.0.1',
      WEB_PORT: '44303',
      E2E_BASE_URL: 'http://127.0.0.1:44303',
      UNRELATED_VALUE: 'preserved',
    })
    expect(baseEnv.SYNIE_CONVEX_INTERNAL_URL).toBe(
      'http://convex-backend:3210',
    )
  })
})
