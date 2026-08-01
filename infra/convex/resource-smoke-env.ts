import { hostWebEnv } from './host-web-env.ts'

export interface ResourceSmokeHostPorts {
  convexPort: string
  sitePort: string
  webPort: string
}

/**
 * 为宿主机上的 Playwright/Vite 进程构造隔离资源烟测环境。
 *
 * composeEnv 会继承根 .env，其中 SSR 私网地址只在 Web 容器内可解析；宿主机
 * Vite 必须把 public 与 SSR 两组 Convex URL 都指向隔离栈的动态回环端口。
 */
export function resourceSmokeHostWebEnv(
  baseEnv: NodeJS.ProcessEnv,
  ports: ResourceSmokeHostPorts,
): NodeJS.ProcessEnv {
  const convexUrl = `http://127.0.0.1:${ports.convexPort}`
  const siteUrl = `http://127.0.0.1:${ports.sitePort}`
  const webOrigin = `http://127.0.0.1:${ports.webPort}`

  return {
    ...hostWebEnv(baseEnv, {
      convexUrl,
      siteUrl,
      appUrl: webOrigin,
    }),
    WEB_HOST: '127.0.0.1',
    WEB_PORT: ports.webPort,
    E2E_BASE_URL: webOrigin,
  }
}
