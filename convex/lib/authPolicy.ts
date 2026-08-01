export function usesSecureSessionCookies(siteUrl: string): boolean {
  return new URL(siteUrl).protocol === 'https:'
}
