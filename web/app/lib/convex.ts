import type { QueryClient } from '@tanstack/react-query'
import { ConvexQueryClient } from '@convex-dev/react-query'
import type { ConvexReactClient } from 'convex/react'

export interface ConvexEnvironment {
  url: string
  siteUrl: string
  appUrl: string
}

export interface SynieRouterContext {
  queryClient: QueryClient
  convexQueryClient: ConvexQueryClient | null
  convexClient: ConvexReactClient | null
}

type ConvexEnvironmentInput = {
  readonly VITE_CONVEX_URL?: string
  readonly VITE_CONVEX_SITE_URL?: string
  readonly VITE_SITE_URL?: string
}

declare global {
  // Production runtime-server.ts writes this before the browser entry module
  // executes, so one immutable image can be deployed behind different URLs.
  var __SYNIE_RUNTIME_CONFIG__: ConvexEnvironmentInput | undefined
}

type ConvexServerEnvironmentInput = {
  readonly SYNIE_CONVEX_INTERNAL_URL?: string
  readonly SYNIE_CONVEX_INTERNAL_SITE_URL?: string
}

function requiredUrl(name: string, value: string | undefined): string {
  const normalized = value?.trim()
  if (!normalized) throw new Error(`convex 模式缺少 ${name}`)

  let parsed: URL
  try {
    parsed = new URL(normalized)
  } catch {
    throw new Error(`convex 模式的 ${name} 不是有效 URL`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`convex 模式的 ${name} 必须使用 http 或 https`)
  }
  return normalized.replace(/\/+$/, '')
}

/**
 * The browser uses the public VITE URLs, while a production SSR container must
 * reach Convex by its private service name. Missing overrides intentionally
 * fall back to the public URLs so host-based development stays zero-config.
 */
export function resolveConvexServerEnvironment(
  publicEnvironment: ConvexEnvironment,
  env: ConvexServerEnvironmentInput,
): ConvexEnvironment {
  return {
    ...publicEnvironment,
    url: env.SYNIE_CONVEX_INTERNAL_URL
      ? requiredUrl('SYNIE_CONVEX_INTERNAL_URL', env.SYNIE_CONVEX_INTERNAL_URL)
      : publicEnvironment.url,
    siteUrl: env.SYNIE_CONVEX_INTERNAL_SITE_URL
      ? requiredUrl(
          'SYNIE_CONVEX_INTERNAL_SITE_URL',
          env.SYNIE_CONVEX_INTERNAL_SITE_URL,
        )
      : publicEnvironment.siteUrl,
  }
}

export function parseConvexEnvironment(
  env: ConvexEnvironmentInput,
): ConvexEnvironment {
  return {
    url: requiredUrl('VITE_CONVEX_URL', env.VITE_CONVEX_URL),
    siteUrl: requiredUrl(
      'VITE_CONVEX_SITE_URL',
      env.VITE_CONVEX_SITE_URL,
    ),
    appUrl: requiredUrl('VITE_SITE_URL', env.VITE_SITE_URL),
  }
}

export function resolveConvexBrowserEnvironment(
  buildEnvironment: ConvexEnvironmentInput,
  runtimeEnvironment: ConvexEnvironmentInput | undefined,
): ConvexEnvironment {
  return parseConvexEnvironment(runtimeEnvironment ?? buildEnvironment)
}

/** 仅在已选择 convex 模式后调用；admin key 永远不属于这个浏览器环境契约。 */
export function getConvexEnvironment(): ConvexEnvironment {
  const buildEnvironment = {
    VITE_CONVEX_URL: import.meta.env.VITE_CONVEX_URL,
    VITE_CONVEX_SITE_URL: import.meta.env.VITE_CONVEX_SITE_URL,
    VITE_SITE_URL: import.meta.env.VITE_SITE_URL,
  }
  const publicEnvironment = import.meta.env.SSR
    ? parseConvexEnvironment(buildEnvironment)
    : resolveConvexBrowserEnvironment(
        buildEnvironment,
        globalThis.__SYNIE_RUNTIME_CONFIG__,
      )
  if (!import.meta.env.SSR) return publicEnvironment

  return resolveConvexServerEnvironment(publicEnvironment, {
    SYNIE_CONVEX_INTERNAL_URL: process.env.SYNIE_CONVEX_INTERNAL_URL,
    SYNIE_CONVEX_INTERNAL_SITE_URL:
      process.env.SYNIE_CONVEX_INTERNAL_SITE_URL,
  })
}
