import { resolve, sep } from 'node:path'

type StartServer = {
  fetch(request: Request): Response | Promise<Response>
}

type RuntimePublicConfig = {
  VITE_CONVEX_URL: string
  VITE_CONVEX_SITE_URL: string
  VITE_SITE_URL: string
}

const RUNTIME_CONFIG_PATH = '/_synie/runtime-config.js'

function runtimeUrl(name: keyof RuntimePublicConfig, value: string | undefined): string {
  const normalized = value?.trim()
  if (!normalized) throw new Error(`production Web 缺少 ${name}`)
  let parsed: URL
  try {
    parsed = new URL(normalized)
  } catch {
    throw new Error(`production Web 的 ${name} 不是有效 URL`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`production Web 的 ${name} 必须使用 http 或 https`)
  }
  return normalized.replace(/\/+$/, '')
}

export function parseRuntimePublicConfig(
  env: Partial<Record<keyof RuntimePublicConfig, string | undefined>>,
): RuntimePublicConfig {
  return {
    VITE_CONVEX_URL: runtimeUrl('VITE_CONVEX_URL', env.VITE_CONVEX_URL),
    VITE_CONVEX_SITE_URL: runtimeUrl('VITE_CONVEX_SITE_URL', env.VITE_CONVEX_SITE_URL),
    VITE_SITE_URL: runtimeUrl('VITE_SITE_URL', env.VITE_SITE_URL),
  }
}

function runtimeConfigJavaScript(config: RuntimePublicConfig): string {
  // Values are validated URLs, but escape '<' as defense in depth if this
  // response is ever embedded instead of loaded as a same-origin script.
  const json = JSON.stringify(config).replaceAll('<', '\\u003c')
  return `globalThis.__SYNIE_RUNTIME_CONFIG__=Object.freeze(${json});\n`
}

export function resolveClientAsset(clientRoot: string, pathname: string): string | null {
  if (!pathname.startsWith('/assets/') || pathname.endsWith('/')) return null
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null
  const root = resolve(clientRoot)
  const assetsRoot = resolve(root, 'assets')
  const candidate = resolve(root, `.${decoded}`)
  return candidate.startsWith(`${assetsRoot}${sep}`) ? candidate : null
}

export function createProductionFetch(
  app: StartServer,
  clientRoot: string,
  runtimeConfig?: RuntimePublicConfig,
) {
  return async (request: Request): Promise<Response> => {
    const method = request.method.toUpperCase()
    if (method === 'GET' || method === 'HEAD') {
      const pathname = new URL(request.url).pathname
      if (runtimeConfig && pathname === RUNTIME_CONFIG_PATH) {
        const body = runtimeConfigJavaScript(runtimeConfig)
        return new Response(method === 'HEAD' ? null : body, {
          headers: {
            'cache-control': 'no-store',
            'content-length': String(Buffer.byteLength(body)),
            'content-type': 'text/javascript; charset=utf-8',
            'x-content-type-options': 'nosniff',
          },
        })
      }
      const assetPath = resolveClientAsset(clientRoot, pathname)
      if (assetPath) {
        const file = Bun.file(assetPath)
        if (await file.exists()) {
          const headers = new Headers({
            'cache-control': 'public, max-age=31536000, immutable',
            'content-length': String(file.size),
            'content-type': file.type || 'application/octet-stream',
            'x-content-type-options': 'nosniff',
          })
          return new Response(method === 'HEAD' ? null : file, { headers })
        }
        return new Response('Not Found', { status: 404 })
      }
    }
    return app.fetch(request)
  }
}

if (import.meta.main) {
  const app = (await import('./dist/server/server.js')).default as StartServer
  const hostname = process.env.HOST?.trim() || '0.0.0.0'
  const port = Number(process.env.PORT ?? 3000)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT 必须是 1..65535 的整数')
  }
  const runtimeConfig = parseRuntimePublicConfig(process.env)
  Bun.serve({
    hostname,
    port,
    fetch: createProductionFetch(
      app,
      resolve(import.meta.dir, 'dist/client'),
      runtimeConfig,
    ),
  })
  console.log(`Synie Web listening on ${hostname}:${port}`)
}
