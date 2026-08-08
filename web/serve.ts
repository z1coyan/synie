/**
 * Synie Web 生产服务器（Bun 原生，无额外依赖）：
 * - dist/client 下的静态资源直接由 Bun.file 返回（/assets/* 带内容 hash，长缓存）
 * - 其余请求交给 TanStack Start SSR 构建产物（dist/server/server.js 的 fetch 入口）
 *
 * 运行前提：已执行 `bun run build`（vite build 产出 dist/client + dist/server）。
 * 环境变量：
 * - PORT / HOST：监听端口与地址（默认 3000 / 0.0.0.0）
 * - SYNIE_API_ORIGIN：SSR 直连后端的 origin（见 app/lib/api/client.ts），
 *   浏览器侧恒走同源相对路径 /api/v1（由反向代理转发到 server）
 */
import path from 'node:path'

const port = Number(process.env.PORT || 3000)
const host = process.env.HOST || '0.0.0.0'
const clientDir = path.resolve(import.meta.dirname, 'dist/client')

/** TanStack Start 构建产物的服务端入口形态（createServerEntry 的默认导出） */
interface StartServerEntry {
  fetch(request: Request): Response | Promise<Response>
}

// 非字面量 specifier：tsc 不做静态解析（dist 为构建产物，typecheck 时可能不存在）
const serverEntryPath = path.resolve(import.meta.dirname, 'dist/server/server.js')
const { default: startServer } = (await import(serverEntryPath)) as { default: StartServerEntry }

const server = Bun.serve({
  port,
  hostname: host,
  async fetch(request) {
    const url = new URL(request.url)
    // 仅 GET/HEAD 尝试静态命中；其余（含 SSR 页面）交给 Start
    if ((request.method === 'GET' || request.method === 'HEAD') && !url.pathname.endsWith('/')) {
      const filePath = path.normalize(path.join(clientDir, url.pathname))
      // 防目录穿越：必须落在 dist/client 内
      if (filePath.startsWith(clientDir + path.sep)) {
        const file = Bun.file(filePath)
        if (await file.exists()) {
          const immutable = url.pathname.startsWith('/assets/')
          return new Response(file, {
            headers: {
              'cache-control': immutable
                ? 'public, max-age=31536000, immutable'
                : 'public, max-age=3600',
            },
          })
        }
      }
    }
    return startServer.fetch(request)
  },
})

console.log(`synie web listening on http://${host}:${server.port}`)
