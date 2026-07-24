/**
 * 权限管理动线(冒烟 setup/teardown):以超管走真实 GraphQL 建「演示会计」角色→授权→
 * 建用户→指派角色与公司→登录取 token。动线本身即断言的一部分——任一 mutation 失败即抛,
 * 冒烟直接红。演示角色/用户临时造,teardown 清理,不进迁移种子。
 */

import { gql, unwrap } from './gql'

export type DemoContext = {
  adminToken: string
  demoToken: string
  username: string
  password: string
  userId: string
  roleId: string
  companyId: string
  /** 演示会计所在公司的一条银行账户别名(断言「本司数据」可见) */
  sampleAlias: string
  /** 他司的一条银行账户别名(断言跨公司不可见);无他司数据时为 null */
  otherCompanyAlias: string | null
}

const ADMIN_USERNAME = process.env.E2E_ADMIN_USERNAME ?? 'admin'
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'admin123'

// 演示会计只授「银行账户读」——刻意不授:base.company:read(验外键降级)、sys.user:read(验未授权页)
const DEMO_PERMISSIONS = ['acc.bank_account:read']

async function login(username: string, password: string): Promise<string> {
  const data = await gql<{ login: { token: string } }>(
    `mutation ($u: String!, $p: String!) { login(username: $u, password: $p) { token } }`,
    { u: username, p: password },
  )
  return data.login.token
}

/** 建演示会计动线,返回可复用的上下文。 */
export async function setupDemoAccountant(): Promise<DemoContext> {
  const adminToken = await login(ADMIN_USERNAME, ADMIN_PASSWORD)

  // 取一条银行账户,以其公司为演示会计的授权公司(复用演示库数据,保证「本司数据」有行)
  const accts = await gql<{
    accBankAccounts: { results: { id: string; alias: string; companyId: string }[] }
  }>(
    `query { accBankAccounts(limit: 200) { results { id alias companyId } } }`,
    {},
    adminToken,
  )
  const rows = accts.accBankAccounts.results
  if (rows.length === 0) {
    throw new Error('演示库没有银行账户——请先 `mix synie.demo` 建演示库再跑冒烟')
  }
  const target = rows[0]
  const companyId = target.companyId
  const sampleAlias = target.alias
  const otherCompanyAlias = rows.find((r) => r.companyId !== companyId)?.alias ?? null

  const suffix = `${Date.now()}`
  const role = unwrap(
    await gql<{ createSysRole: { result: { id: string } | null; errors: { message: string }[] | null } }>(
      `mutation ($input: CreateSysRoleInput!) { createSysRole(input: $input) { result { id } errors { message } } }`,
      { input: { code: `e2e_demo_acc_${suffix}`, name: '演示会计(冒烟)' } },
      adminToken,
    ).then((d) => d.createSysRole),
  )
  const roleId = role.id

  await gql<{ syncSysRolePermissions: string[] }>(
    `mutation ($roleId: ID!, $permissions: [String!]!) { syncSysRolePermissions(roleId: $roleId, permissions: $permissions) }`,
    { roleId, permissions: DEMO_PERMISSIONS },
    adminToken,
  )

  const username = `e2e_demo_${suffix}`
  const created = await gql<{ createSysUser: { id: string; username: string; password: string } }>(
    `mutation ($username: String!, $name: String) { createSysUser(username: $username, name: $name) { id username password } }`,
    { username, name: '演示会计' },
    adminToken,
  )
  const userId = created.createSysUser.id
  const password = created.createSysUser.password

  unwrap(
    await gql<{ createSysUserRole: { result: { id: string } | null; errors: { message: string }[] | null } }>(
      `mutation ($input: CreateSysUserRoleInput!) { createSysUserRole(input: $input) { result { id } errors { message } } }`,
      { input: { userId, roleId } },
      adminToken,
    ).then((d) => d.createSysUserRole),
  )

  unwrap(
    await gql<{ createSysUserCompany: { result: { id: string } | null; errors: { message: string }[] | null } }>(
      `mutation ($input: CreateSysUserCompanyInput!) { createSysUserCompany(input: $input) { result { id } errors { message } } }`,
      { input: { userId, companyId } },
      adminToken,
    ).then((d) => d.createSysUserCompany),
  )

  // 以演示会计登录取 token(证明动线到「登录生效」这条端到端可信)
  const demoToken = await login(username, password)

  return {
    adminToken,
    demoToken,
    username,
    password,
    userId,
    roleId,
    companyId,
    sampleAlias,
    otherCompanyAlias,
  }
}

/** 清理演示会计角色/用户(join 行随宿主级联,或后端 destroy 自理)。 */
export async function teardownDemoAccountant(ctx: Pick<DemoContext, 'adminToken' | 'userId' | 'roleId'>) {
  await gql(
    `mutation ($id: ID!) { destroySysUser(id: $id) { errors { message } } }`,
    { id: ctx.userId },
    ctx.adminToken,
  ).catch(() => undefined)

  await gql(
    `mutation ($id: ID!) { destroySysRole(id: $id) { errors { message } } }`,
    { id: ctx.roleId },
    ctx.adminToken,
  ).catch(() => undefined)
}
