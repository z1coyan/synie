import { ConvexHttpClient } from 'convex/browser'
import { makeFunctionReference } from 'convex/server'
import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { log, requireLocalConvexCredentials, root } from './lib.ts'

type Store = 'financeDocuments' | 'tradingDocuments' | 'manufacturingDocuments'
type RepairResult = { processed: number; continueCursor: string | null; isDone: boolean }

const rebuildPageRef = makeFunctionReference<
  'mutation',
  { store: Store; cursor?: string | null },
  RepairResult
>('candidateRepair:rebuildPage')

type Credential = { project: string; web: string; username: string; password: string }

function credentialPath(project: string): string {
  return process.argv[2]
    ? resolve(process.argv[2])
    : resolve(root, 'infra/convex/backups', `final-local-admin-${project}.txt`)
}

function readCredential(project: string): Credential {
  const path = credentialPath(project)
  const stat = statSync(path)
  if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) {
    throw new Error('管理员凭据必须是权限 0600 的普通文件')
  }
  const fields = new Map<string, string>()
  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const separator = rawLine.indexOf('=')
    if (separator < 1) continue
    const key = rawLine.slice(0, separator).trim()
    const value = rawLine.slice(separator + 1)
    if (fields.has(key)) throw new Error(`管理员凭据字段重复：${key}`)
    fields.set(key, value)
  }
  const credential = {
    project: fields.get('project')?.trim() ?? '',
    web: fields.get('web')?.trim() ?? '',
    username: fields.get('username')?.trim() ?? '',
    password: fields.get('password') ?? '',
  }
  if (credential.project !== project || !credential.username || !credential.password) {
    throw new Error('管理员凭据与当前 Compose project 不匹配或字段缺失')
  }
  const web = new URL(credential.web)
  if (!['http:', 'https:'].includes(web.protocol) || web.username || web.password) {
    throw new Error('管理员凭据 web 必须是无内嵌认证的 HTTP(S) URL')
  }
  return { ...credential, web: web.origin }
}

function endpoint(base: string, path: string): string {
  return `${base.replace(/\/$/, '')}/${path.replace(/^\//, '')}`
}

function cookieHeader(headers: Headers): string {
  const extended = headers as Headers & { getSetCookie?: () => string[] }
  const values = extended.getSetCookie?.() ??
    (headers.get('set-cookie') ? [headers.get('set-cookie')!] : [])
  return values.map((value) => value.split(';', 1)[0]).filter(Boolean).join('; ')
}

function authHeaders(authBaseUrl: string, siteOrigin: string): Record<string, string> {
  if (new URL(authBaseUrl).origin === siteOrigin) return { origin: siteOrigin }
  const publicUrl = new URL(siteOrigin)
  return {
    origin: siteOrigin,
    'x-better-auth-forwarded-host': publicUrl.host,
    'x-better-auth-forwarded-proto': publicUrl.protocol.replace(':', ''),
  }
}

async function authenticatedClient(input: {
  convexUrl: string
  authBaseUrl: string
  siteOrigin: string
  username: string
  password: string
}): Promise<{ client: ConvexHttpClient; cookie: string; headers: Record<string, string> }> {
  const headers = authHeaders(input.authBaseUrl, input.siteOrigin)
  const signIn = await fetch(endpoint(input.authBaseUrl, 'sign-in/username'), {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ username: input.username, password: input.password, rememberMe: false }),
    redirect: 'manual',
  })
  if (!signIn.ok) throw new Error(`超级管理员登录失败：HTTP ${signIn.status}`)
  const cookie = cookieHeader(signIn.headers)
  if (!cookie) throw new Error('超级管理员登录未返回 session cookie')
  const tokenResponse = await fetch(endpoint(input.authBaseUrl, 'convex/token'), {
    headers: { ...headers, cookie },
    redirect: 'manual',
  })
  if (!tokenResponse.ok) throw new Error(`Convex JWT 获取失败：HTTP ${tokenResponse.status}`)
  const token = (await tokenResponse.json() as { token?: unknown }).token
  if (typeof token !== 'string' || !token) throw new Error('Convex JWT 缺失')
  const client = new ConvexHttpClient(input.convexUrl, {
    skipConvexDeploymentUrlCheck: true,
    logger: false,
  })
  client.setAuth(token)
  return { client, cookie, headers }
}

async function signOut(authBaseUrl: string, headers: Record<string, string>, cookie: string): Promise<void> {
  const response = await fetch(endpoint(authBaseUrl, 'sign-out'), {
    method: 'POST',
    headers: { ...headers, cookie, 'content-type': 'application/json' },
    body: '{}',
    redirect: 'manual',
  })
  if (!response.ok) throw new Error(`repair session 退出失败：HTTP ${response.status}`)
}

async function rebuildStore(client: ConvexHttpClient, store: Store): Promise<number> {
  let cursor: string | null = null
  let processed = 0
  const seen = new Set<string>()
  for (let pageNo = 0; pageNo < 100_000; pageNo++) {
    const result: RepairResult = await client.mutation(rebuildPageRef, { store, cursor })
    processed += result.processed
    if (result.isDone) return processed
    if (!result.continueCursor || seen.has(result.continueCursor)) {
      throw new Error(`${store} repair 返回空或重复 cursor`)
    }
    seen.add(result.continueCursor)
    cursor = result.continueCursor
  }
  throw new Error(`${store} repair 超出安全分页上限`)
}

async function main(): Promise<void> {
  const env = requireLocalConvexCredentials()
  const project = env.COMPOSE_PROJECT_NAME?.trim()
  if (!project || !/^[a-z0-9][a-z0-9_-]{2,80}$/.test(project)) {
    throw new Error('COMPOSE_PROJECT_NAME 缺失或不合法')
  }
  const credential = readCredential(project)
  const convexUrl = env.CONVEX_SELF_HOSTED_URL!
  const siteUrl = env.CONVEX_SELF_HOSTED_SITE_URL
  if (!siteUrl) throw new Error('缺少 CONVEX_SELF_HOSTED_SITE_URL；请先运行 bun run convex:bootstrap')
  const authBaseUrl = endpoint(siteUrl, 'api/auth')
  const session = await authenticatedClient({
    convexUrl,
    authBaseUrl,
    siteOrigin: credential.web,
    username: credential.username,
    password: credential.password,
  })
  try {
    for (const store of ['financeDocuments', 'tradingDocuments', 'manufacturingDocuments'] as const) {
      const processed = await rebuildStore(session.client, store)
      log(`候选投影 repair 完成：${store}=${processed}`)
    }
  } finally {
    await signOut(authBaseUrl, session.headers, session.cookie)
  }
}

main().catch((error) => {
  console.error('[synie:convex] 候选投影 repair 失败:', error instanceof Error ? error.message : '未知错误')
  process.exit(1)
})
