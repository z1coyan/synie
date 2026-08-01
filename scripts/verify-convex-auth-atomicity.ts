import { ConvexHttpClient } from 'convex/browser'
import { makeFunctionReference } from 'convex/server'

type FaultPoint =
  | 'after_auth_user'
  | 'after_credential'
  | 'after_app_user'
  | 'after_setup_state'

type UserResult = {
  user: { id: string; username: string; name: string | null }
}

type Inspection = {
  authUserExists: boolean
  credentialExists: boolean
  appUserExists: boolean
  setupStateExists: boolean
  authStoreEmpty: boolean
  appStoreEmpty: boolean
  authStoreSingleton: boolean
  appStoreSingleton: boolean
  authUserLinkedToAppUser: boolean
  setupStateLinkedToAppUser: boolean
  clean: boolean
}

type Me = {
  user: { id: string; username: string; name: string | null }
  superAdmin: boolean
  allCompanies: boolean
  permissions: string[]
  companyIds: string[]
}

type Role = {
  id: string
  code: string
  name: string
  enabled: boolean
  builtin: boolean
}

type ManagedUser = {
  user: { id: string; username: string; name: string | null }
  password: string
}

const inspectRef = makeFunctionReference<
  'query',
  { spikeSecret: string; username: string },
  Inspection
>('setup/spike:inspect')
const faultRef = makeFunctionReference<
  'mutation',
  {
    spikeSecret: string
    faultPoint: FaultPoint
    username: string
    password: string
    name: string | null
  },
  UserResult
>('setup/spike:createFirstUserWithFault')
const createFirstUserRef = makeFunctionReference<
  'mutation',
  { username: string; password: string; name: string | null },
  UserResult
>('setup/createFirstUser:createFirstUser')
const statusRef = makeFunctionReference<
  'query',
  Record<string, never>,
  { initialized: boolean; hasUsers: boolean }
>('setup/status:get')
const meRef = makeFunctionReference<'query', Record<string, never>, Me>('iam/me:get')
const createRoleRef = makeFunctionReference<
  'mutation',
  { code: string; name: string; enabled?: boolean },
  Role
>('iam/roles:create')
const updateRoleRef = makeFunctionReference<
  'mutation',
  { id: string; name?: string; enabled?: boolean },
  Role
>('iam/roles:update')
const syncPermissionsRef = makeFunctionReference<
  'mutation',
  { id: string; permissions: string[] },
  string[]
>('iam/roles:syncPermissions')
const createUserRef = makeFunctionReference<
  'mutation',
  { username: string; name?: string | null; roleIds?: string[]; companyIds?: string[] },
  ManagedUser
>('iam/users:create')
const updateUserRef = makeFunctionReference<
  'mutation',
  { id: string; name?: string | null; roleIds?: string[]; companyIds?: string[] },
  { id: string; username: string; name: string | null }
>('iam/users:update')
const resetPasswordRef = makeFunctionReference<
  'mutation',
  { id: string },
  { password: string }
>('iam/users:resetPassword')
const removeUserRef = makeFunctionReference<'mutation', { id: string }, null>(
  'iam/users:remove',
)
const permissionProbeRef = makeFunctionReference<'query', Record<string, never>, true>(
  'iam/probe:permission',
)

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`缺少环境变量 ${name}`)
  return value
}

function newClient(convexUrl: string): ConvexHttpClient {
  return new ConvexHttpClient(convexUrl, {
    skipConvexDeploymentUrlCheck: true,
    logger: false,
  })
}

function assertInvariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}`
}

function cookieHeader(headers: Headers): string {
  const withGetSetCookie = headers as Headers & { getSetCookie?: () => string[] }
  const values = withGetSetCookie.getSetCookie?.() ??
    (headers.get('set-cookie') ? [headers.get('set-cookie') as string] : [])
  return values.map((value) => value.split(';', 1)[0]).filter(Boolean).join('; ')
}

function forwardedHeaders(
  authBaseUrl: string,
  siteOrigin: string,
  forwardedFor?: string,
): Record<string, string> {
  const authOrigin = new URL(authBaseUrl).origin
  if (authOrigin === siteOrigin) {
    return { origin: siteOrigin, ...(forwardedFor ? { 'x-forwarded-for': forwardedFor } : {}) }
  }
  const publicUrl = new URL(siteOrigin)
  return {
    origin: siteOrigin,
    'x-better-auth-forwarded-host': publicUrl.host,
    'x-better-auth-forwarded-proto': publicUrl.protocol.replace(':', ''),
    ...(forwardedFor ? { 'x-forwarded-for': forwardedFor } : {}),
  }
}

function assertNoInternalEmail(value: unknown, label: string): void {
  const serialized = JSON.stringify(value)
  assertInvariant(!serialized.includes('@internal.syn.ie'), `${label} 泄漏内部邮箱值`)
  if (value && typeof value === 'object' && 'user' in value) {
    const user = (value as { user?: unknown }).user
    assertInvariant(
      !(user && typeof user === 'object' && 'email' in user),
      `${label} 泄漏内部 email 字段`,
    )
  }
}

type AuthenticatedSession = {
  cookie: string
  client: ConvexHttpClient
  fetchToken: () => Promise<string>
}

async function signIn(input: {
  authBaseUrl: string
  siteOrigin: string
  convexUrl: string
  username: string
  password: string
  forwardedFor: string
}): Promise<AuthenticatedSession> {
  const commonHeaders = forwardedHeaders(
    input.authBaseUrl,
    input.siteOrigin,
    input.forwardedFor,
  )
  const response = await fetch(endpoint(input.authBaseUrl, 'sign-in/username'), {
    method: 'POST',
    headers: { ...commonHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ username: input.username, password: input.password, rememberMe: false }),
    redirect: 'manual',
  })
  const responseBody = (await response.json().catch(() => null)) as unknown
  assertInvariant(response.ok, `username 登录失败：HTTP ${response.status}`)
  assertNoInternalEmail(responseBody, 'username 登录响应')
  const cookie = cookieHeader(response.headers)
  assertInvariant(cookie, 'username 登录未返回 HttpOnly session cookie')

  const sessionResponse = await fetch(endpoint(input.authBaseUrl, 'get-session'), {
    method: 'GET',
    headers: { ...commonHeaders, cookie },
  })
  assertInvariant(sessionResponse.ok, `session 查询失败：HTTP ${sessionResponse.status}`)
  assertNoInternalEmail(await sessionResponse.json(), 'session 响应')

  const fetchToken = async () => {
    const tokenResponse = await fetch(endpoint(input.authBaseUrl, 'convex/token'), {
      method: 'GET',
      headers: { ...commonHeaders, cookie },
      redirect: 'manual',
    })
    assertInvariant(tokenResponse.ok, `Convex JWT 获取失败：HTTP ${tokenResponse.status}`)
    const tokenBody = (await tokenResponse.json()) as { token?: unknown }
    assertInvariant(
      typeof tokenBody.token === 'string' && tokenBody.token,
      'Convex JWT 响应缺少 token',
    )
    return tokenBody.token
  }

  const client = newClient(input.convexUrl)
  client.setAuth(await fetchToken())
  return { cookie, client, fetchToken }
}

async function signOut(input: {
  authBaseUrl: string
  siteOrigin: string
  cookie: string
  forwardedFor: string
}): Promise<void> {
  const response = await fetch(endpoint(input.authBaseUrl, 'sign-out'), {
    method: 'POST',
    headers: {
      ...forwardedHeaders(input.authBaseUrl, input.siteOrigin, input.forwardedFor),
      cookie: input.cookie,
      'content-type': 'application/json',
    },
    body: '{}',
    redirect: 'manual',
  })
  assertInvariant(response.ok, `退出失败：HTTP ${response.status}`)
}

async function failedSignIn(input: {
  authBaseUrl: string
  siteOrigin: string
  username: string
  password: string
  forwardedFor: string
}): Promise<{ status: number; body: string; elapsedMs: number }> {
  const startedAt = performance.now()
  const response = await fetch(endpoint(input.authBaseUrl, 'sign-in/username'), {
    method: 'POST',
    headers: {
      ...forwardedHeaders(input.authBaseUrl, input.siteOrigin, input.forwardedFor),
      'content-type': 'application/json',
    },
    body: JSON.stringify({ username: input.username, password: input.password }),
    redirect: 'manual',
  })
  const body = await response.text()
  return { status: response.status, body, elapsedMs: performance.now() - startedAt }
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)]
}

async function verifyLoginProtection(input: {
  authBaseUrl: string
  siteOrigin: string
  convexUrl: string
  username: string
  password: string
}): Promise<void> {
  const existingFailure = await failedSignIn({
    ...input,
    password: `${input.password}-wrong`,
    forwardedFor: '198.51.100.10',
  })
  const unknownFailure = await failedSignIn({
    ...input,
    username: `unknown-${crypto.randomUUID()}`,
    password: `${input.password}-wrong`,
    forwardedFor: '198.51.100.10',
  })
  assertInvariant(
    existingFailure.status === unknownFailure.status &&
      existingFailure.body === unknownFailure.body,
    '错误用户与错误密码响应可用于枚举账号',
  )

  const knownTimings: number[] = []
  const unknownTimings: number[] = []
  for (let sample = 0; sample < 5; sample += 1) {
    const known = await failedSignIn({
      ...input,
      password: `${input.password}-timing-wrong`,
      forwardedFor: '198.51.100.11',
    })
    const unknown = await failedSignIn({
      ...input,
      username: `timing-unknown-${crypto.randomUUID()}`,
      password: `${input.password}-timing-wrong`,
      forwardedFor: '198.51.100.12',
    })
    assertInvariant(
      known.status === unknown.status && known.body === unknown.body,
      '计时样本的认证错误响应发生漂移',
    )
    knownTimings.push(known.elapsedMs)
    unknownTimings.push(unknown.elapsedMs)
  }
  const knownMedian = median(knownTimings)
  const unknownMedian = median(unknownTimings)
  const fasterMedian = Math.min(knownMedian, unknownMedian)
  const slowerMedian = Math.max(knownMedian, unknownMedian)
  // 宽松门槛只捕获“未知用户直接返回、已知用户做密码哈希”这类数量级泄漏，
  // 不把共享 CI 主机的正常抖动误判成安全回归。
  assertInvariant(
    slowerMedian <= fasterMedian * 4 + 150,
    '错误用户与错误密码耗时存在明显数量级差异',
  )

  const lockedIp = '198.51.100.20'
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const failure = await failedSignIn({
      ...input,
      password: `${input.password}-wrong`,
      forwardedFor: lockedIp,
    })
    assertInvariant(failure.status !== 429, `第 ${attempt} 次失败不应提前限流`)
  }
  const eleventh = await failedSignIn({
    ...input,
    password: `${input.password}-wrong`,
    forwardedFor: lockedIp,
  })
  assertInvariant(eleventh.status === 429, `第 11 次失败应限流，实际 HTTP ${eleventh.status}`)
  const correctWhileLocked = await failedSignIn({ ...input, forwardedFor: lockedIp })
  assertInvariant(correctWhileLocked.status === 429, '锁定窗口内正确密码不应绕过限流')

  const resetIp = '198.51.100.30'
  await failedSignIn({
    ...input,
    password: `${input.password}-wrong`,
    forwardedFor: resetIp,
  })
  const resetSession = await signIn({ ...input, forwardedFor: resetIp })
  await signOut({
    authBaseUrl: input.authBaseUrl,
    siteOrigin: input.siteOrigin,
    cookie: resetSession.cookie,
    forwardedFor: resetIp,
  })
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const failure = await failedSignIn({
      ...input,
      password: `${input.password}-wrong-again`,
      forwardedFor: resetIp,
    })
    assertInvariant(failure.status !== 429, '成功登录后失败计数未清零')
  }
  const afterResetEleventh = await failedSignIn({
    ...input,
    password: `${input.password}-wrong-again`,
    forwardedFor: resetIp,
  })
  assertInvariant(afterResetEleventh.status === 429, '成功清零后的新窗口未在第 11 次限流')
}

async function verifyIamClosure(input: {
  authBaseUrl: string
  siteOrigin: string
  convexUrl: string
  marker: string
  adminClient: ConvexHttpClient
}): Promise<void> {
  const role = await input.adminClient.mutation(createRoleRef, {
    code: `spike-${input.marker}`,
    name: '认证烟测角色',
  })
  await input.adminClient.mutation(syncPermissionsRef, {
    id: role.id,
    permissions: ['test.actor:read'],
  })
  const username = `员工-${input.marker}`
  const created = await input.adminClient.mutation(createUserRef, {
    username,
    name: '受管用户',
    roleIds: [role.id],
    companyIds: ['company-b', 'company-a'],
  })
  assertNoInternalEmail(created, '用户创建响应')

  const childIp = '198.51.100.40'
  const child = await signIn({
    authBaseUrl: input.authBaseUrl,
    siteOrigin: input.siteOrigin,
    convexUrl: input.convexUrl,
    username: username.toUpperCase(),
    password: created.password,
    forwardedFor: childIp,
  })
  const initialMe = await child.client.query(meRef, {})
  assertInvariant(
    initialMe.permissions.join(',') === 'test.actor:read',
    '受管用户未获得角色权限',
  )
  assertInvariant(
    initialMe.companyIds.join(',') === 'company-a,company-b',
    '受管用户公司授权不正确',
  )
  assertInvariant(await child.client.query(permissionProbeRef, {}), '权限探针未通过')

  await input.adminClient.mutation(updateRoleRef, { id: role.id, enabled: false })
  const disabledMe = await child.client.query(meRef, {})
  assertInvariant(disabledMe.permissions.length === 0, '停用角色未立即撤销权限')
  let disabledRejected = false
  try {
    await child.client.query(permissionProbeRef, {})
  } catch {
    disabledRejected = true
  }
  assertInvariant(disabledRejected, '停用角色后权限入口未 fail-closed')

  await input.adminClient.mutation(updateRoleRef, { id: role.id, enabled: true })
  await input.adminClient.mutation(syncPermissionsRef, {
    id: role.id,
    permissions: ['test.actor:other'],
  })
  const changedMe = await child.client.query(meRef, {})
  assertInvariant(
    changedMe.permissions.join(',') === 'test.actor:other',
    '同一 session 未立即反映授权变更',
  )
  await input.adminClient.mutation(syncPermissionsRef, {
    id: role.id,
    permissions: ['test.actor:read'],
  })
  assertInvariant(await child.client.query(permissionProbeRef, {}), '恢复授权后探针未通过')

  await input.adminClient.mutation(updateUserRef, {
    id: created.user.id,
    companyIds: ['company-c'],
  })
  const companyChanged = await child.client.query(meRef, {})
  assertInvariant(
    companyChanged.companyIds.join(',') === 'company-c',
    '同一 session 未立即反映公司授权变更',
  )

  const reset = await input.adminClient.mutation(resetPasswordRef, { id: created.user.id })
  let oldSessionRevoked = false
  try {
    await child.client.query(meRef, {})
  } catch {
    oldSessionRevoked = true
  }
  assertInvariant(oldSessionRevoked, '重置密码后旧 session 未撤销')
  const oldPassword = await failedSignIn({
    authBaseUrl: input.authBaseUrl,
    siteOrigin: input.siteOrigin,
    username,
    password: created.password,
    forwardedFor: '198.51.100.41',
  })
  assertInvariant(oldPassword.status >= 400, '重置密码后旧密码仍可登录')
  const resetSession = await signIn({
    authBaseUrl: input.authBaseUrl,
    siteOrigin: input.siteOrigin,
    convexUrl: input.convexUrl,
    username,
    password: reset.password,
    forwardedFor: '198.51.100.42',
  })
  assertInvariant(
    (await resetSession.client.query(meRef, {})).user.id === created.user.id,
    '重置密码后新密码无法恢复 Actor',
  )

  await input.adminClient.mutation(removeUserRef, { id: created.user.id })
  let deletedSessionRejected = false
  try {
    await resetSession.client.query(meRef, {})
  } catch {
    deletedSessionRejected = true
  }
  assertInvariant(deletedSessionRejected, '删除用户后旧 session 仍可访问 Actor')
  const deletedLogin = await failedSignIn({
    authBaseUrl: input.authBaseUrl,
    siteOrigin: input.siteOrigin,
    username,
    password: reset.password,
    forwardedFor: '198.51.100.43',
  })
  assertInvariant(deletedLogin.status >= 400, '删除用户后凭证仍可登录')
}

async function signInAndVerifyMe(input: {
  authBaseUrl: string
  siteOrigin: string
  convexUrl: string
  username: string
  password: string
  expectedUserId: string
}) {
  await verifyLoginProtection(input)
  const session = await signIn({ ...input, forwardedFor: '198.51.100.50' })
  const me = await session.client.query(meRef, {})
  assertInvariant(me.user.id === input.expectedUserId, 'iam/me 与 setup app user 不一致')
  assertInvariant(me.user.username === input.username, 'iam/me username 不一致')
  assertInvariant(me.superAdmin && me.allCompanies, '首管理员 Actor 权限标志不正确')
  assertInvariant(!('email' in me.user), 'iam/me 泄漏 Better Auth 内部邮箱')

  await verifyIamClosure({
    authBaseUrl: input.authBaseUrl,
    siteOrigin: input.siteOrigin,
    convexUrl: input.convexUrl,
    marker: input.username.replace(/^auth-spike-/, ''),
    adminClient: session.client,
  })

  const restartProject = process.env.SYNIE_AUTH_SPIKE_COMPOSE_PROJECT?.trim()
  if (restartProject) {
    assertInvariant(
      /^[a-z0-9][a-z0-9_-]{5,80}$/.test(restartProject) &&
        process.env.COMPOSE_PROJECT_NAME === restartProject,
      '重启验证要求安全且一致的 COMPOSE_PROJECT_NAME',
    )
    const restart = Bun.spawn(
      ['bun', 'infra/convex/compose.ts', 'restart', 'convex-backend'],
      { cwd: new URL('..', import.meta.url).pathname, env: process.env, stdout: 'inherit', stderr: 'inherit' },
    )
    assertInvariant((await restart.exited) === 0, 'Convex backend 重启失败')
    let ready = false
    for (let attempt = 0; attempt < 80; attempt += 1) {
      try {
        const response = await fetch(endpoint(input.convexUrl, 'version'))
        if (response.ok) {
          ready = true
          break
        }
      } catch {
        // Backend is expected to refuse connections briefly during restart.
      }
      await Bun.sleep(250)
    }
    assertInvariant(ready, 'Convex backend 重启后未恢复健康')
    session.client.setAuth(await session.fetchToken())
    const afterRestart = await session.client.query(meRef, {})
    assertInvariant(afterRestart.user.id === input.expectedUserId, '重启后 session/Actor 未恢复')
  }

  await signOut({
    authBaseUrl: input.authBaseUrl,
    siteOrigin: input.siteOrigin,
    cookie: session.cookie,
    forwardedFor: '198.51.100.50',
  })

  let revoked = false
  try {
    await session.client.query(meRef, {})
  } catch {
    revoked = true
  }
  assertInvariant(revoked, '退出后旧 session 仍可读取 iam/me')
}

async function main() {
  const convexUrl = requiredEnv('CONVEX_SELF_HOSTED_URL')
  const convexSiteUrl = requiredEnv('CONVEX_SELF_HOSTED_SITE_URL')
  const spikeSecret = requiredEnv('SYNIE_AUTH_SPIKE_SECRET')
  const authBaseUrl =
    process.env.SYNIE_AUTH_SPIKE_AUTH_BASE_URL?.trim() || endpoint(convexSiteUrl, 'api/auth')
  const siteOrigin =
    process.env.SYNIE_AUTH_SPIKE_SITE_ORIGIN?.trim() ||
    process.env.VITE_SITE_URL?.trim() ||
    new URL(authBaseUrl).origin
  const concurrency = Number(process.env.SYNIE_AUTH_SPIKE_CONCURRENCY ?? '20')
  assertInvariant(Number.isInteger(concurrency) && concurrency >= 2 && concurrency <= 50,
    'SYNIE_AUTH_SPIKE_CONCURRENCY 必须是 2..50 的整数')

  const marker = crypto.randomUUID().replaceAll('-', '').slice(0, 20)
  const username = `auth-spike-${marker}`
  const password = `Spike-${crypto.randomUUID()}`
  const name = '认证原子性探针'
  const client = newClient(convexUrl)
  const inspect = () => client.query(inspectRef, { spikeSecret, username })

  const initial = await inspect()
  assertInvariant(
    initial.clean,
    'auth spike 只能在全新 deployment 运行（检测到 Better Auth 或应用用户状态）',
  )

  const faultPoints: readonly FaultPoint[] = [
    'after_auth_user',
    'after_credential',
    'after_app_user',
    'after_setup_state',
  ]
  for (const faultPoint of faultPoints) {
    let rejected = false
    try {
      await client.mutation(faultRef, {
        spikeSecret,
        faultPoint,
        username,
        password,
        name,
      })
    } catch {
      rejected = true
    }
    assertInvariant(rejected, `故障点 ${faultPoint} 未中断 mutation`)
    const afterFault = await inspect()
    assertInvariant(afterFault.clean, `故障点 ${faultPoint} 留下跨组件半状态`)
  }

  const attempts = await Promise.allSettled(
    Array.from({ length: concurrency }, () =>
      newClient(convexUrl).mutation(createFirstUserRef, { username, password, name }),
    ),
  )
  const successes = attempts.filter(
    (attempt): attempt is PromiseFulfilledResult<UserResult> => attempt.status === 'fulfilled',
  )
  assertInvariant(successes.length === 1, `并发初始化成功数应为 1，实际为 ${successes.length}`)
  const created = successes[0].value

  const finalInspection = await inspect()
  assertInvariant(finalInspection.authUserExists, '成功初始化后缺少 Better Auth user')
  assertInvariant(finalInspection.credentialExists, '成功初始化后缺少 credential account')
  assertInvariant(finalInspection.appUserExists, '成功初始化后缺少 appUsers')
  assertInvariant(finalInspection.setupStateExists, '成功初始化后缺少 setupState')
  assertInvariant(finalInspection.authStoreSingleton, '并发初始化留下多余 auth user/credential')
  assertInvariant(finalInspection.appStoreSingleton, '并发初始化留下多余 appUser/setupState')
  assertInvariant(finalInspection.authUserLinkedToAppUser, 'Better Auth userId 未链接 appUsers')
  assertInvariant(finalInspection.setupStateLinkedToAppUser, 'setupState 未链接首管理员')

  const status = await client.query(statusRef, {})
  assertInvariant(status.initialized && status.hasUsers, 'setup/status 未反映首管理员状态')
  await signInAndVerifyMe({
    authBaseUrl,
    siteOrigin,
    convexUrl,
    username,
    password,
    expectedUserId: created.user.id,
  })

  console.log(
    `Convex auth atomicity spike 通过：faults=${faultPoints.length} concurrency=${concurrency} ` +
      'auth/component/app/setup=atomic signin/me/signout=ok',
  )
}

await main()
