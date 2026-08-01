import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createProductionFetch,
  parseRuntimePublicConfig,
  resolveClientAsset,
} from './runtime-server'

describe('production Web runtime', () => {
  test('only resolves normalized generated asset paths', () => {
    const root = '/srv/client'
    expect(resolveClientAsset(root, '/assets/index-abc.js')).toBe('/srv/client/assets/index-abc.js')
    expect(resolveClientAsset(root, '/login')).toBeNull()
    expect(resolveClientAsset(root, '/assets/')).toBeNull()
    expect(resolveClientAsset(root, '/assets/%2e%2e/server.js')).toBeNull()
    expect(resolveClientAsset(root, '/assets/%5c..%5cserver.js')).toBeNull()
    expect(resolveClientAsset(root, '/assets/%E0%A4%A')).toBeNull()
  })

  test('serves immutable assets and delegates application routes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'synie-web-runtime-'))
    mkdirSync(join(root, 'assets'))
    writeFileSync(join(root, 'assets/index-abc.js'), 'export const ready=true')
    const app = { fetch: (request: Request) => new Response(new URL(request.url).pathname) }
    const fetch = createProductionFetch(app, root)
    try {
      const asset = await fetch(new Request('http://local/assets/index-abc.js'))
      expect(asset.status).toBe(200)
      expect(asset.headers.get('cache-control')).toContain('immutable')
      expect(asset.headers.get('content-type')).toContain('javascript')
      expect(await asset.text()).toContain('ready=true')

      const head = await fetch(new Request('http://local/assets/index-abc.js', { method: 'HEAD' }))
      expect(head.status).toBe(200)
      expect(await head.text()).toBe('')
      expect((await fetch(new Request('http://local/assets/missing.js'))).status).toBe(404)
      expect(await (await fetch(new Request('http://local/login'))).text()).toBe('/login')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('serves validated public Convex URLs from the container runtime', async () => {
    const config = parseRuntimePublicConfig({
      VITE_CONVEX_URL: 'http://127.0.0.1:38210/',
      VITE_CONVEX_SITE_URL: 'http://127.0.0.1:38211/',
      VITE_SITE_URL: 'http://127.0.0.1:38300/',
    })
    const fetch = createProductionFetch(
      { fetch: () => new Response('application') },
      '/srv/client',
      config,
    )

    const response = await fetch(new Request('http://local/_synie/runtime-config.js'))
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('content-type')).toContain('javascript')
    expect(await response.text()).toContain('http://127.0.0.1:38210')
    expect(await (await fetch(new Request('http://local/_synie/runtime-config.js', {
      method: 'HEAD',
    }))).text()).toBe('')

    expect(() => parseRuntimePublicConfig({
      VITE_CONVEX_URL: 'ws://127.0.0.1:38210',
      VITE_CONVEX_SITE_URL: 'http://127.0.0.1:38211',
      VITE_SITE_URL: 'http://127.0.0.1:38300',
    })).toThrow('http 或 https')
  })
})
