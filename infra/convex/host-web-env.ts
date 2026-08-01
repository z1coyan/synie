export interface HostWebEnvOverrides {
  convexUrl?: string
  siteUrl?: string
  appUrl?: string
}

function requiredHostUrl(
  name: 'CONVEX_SELF_HOSTED_URL' | 'CONVEX_SELF_HOSTED_SITE_URL',
  value: string | undefined,
): string {
  const normalized = value?.trim()
  if (!normalized) throw new Error(`宿主 Web 环境缺少 ${name}`)
  return normalized
}

/**
 * 宿主机 TanStack Start 的 SSR 与浏览器地址边界。
 *
 * SSR 默认跟随宿主可达的 self-hosted URL；隔离测试可显式传入动态
 * loopback URL，并让同一次 Vite 启动的 public URL 与其保持一致。
 */
export function hostWebEnv(
  baseEnv: NodeJS.ProcessEnv,
  overrides: HostWebEnvOverrides = {},
): NodeJS.ProcessEnv {
  const convexUrl = requiredHostUrl(
    'CONVEX_SELF_HOSTED_URL',
    overrides.convexUrl ?? baseEnv.CONVEX_SELF_HOSTED_URL,
  )
  const siteUrl = requiredHostUrl(
    'CONVEX_SELF_HOSTED_SITE_URL',
    overrides.siteUrl ?? baseEnv.CONVEX_SELF_HOSTED_SITE_URL,
  )

  return {
    ...baseEnv,
    VITE_CONVEX_URL:
      overrides.convexUrl ?? baseEnv.VITE_CONVEX_URL ?? convexUrl,
    VITE_CONVEX_SITE_URL:
      overrides.siteUrl ?? baseEnv.VITE_CONVEX_SITE_URL ?? siteUrl,
    ...(overrides.appUrl ? { VITE_SITE_URL: overrides.appUrl } : {}),
    SYNIE_CONVEX_INTERNAL_URL: convexUrl,
    SYNIE_CONVEX_INTERNAL_SITE_URL: siteUrl,
  }
}
