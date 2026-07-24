# 权限浏览器薄冒烟(authz-e2e)

验证「前端消费权限」的端到端动线,是 authz-e2e 三层防线的**辅缝**——不承担覆盖率
(覆盖率全在 API 矩阵 `backend/apps/synie_web/test/synie_web/authz_matrix_*`),
**不进 PR CI**(依赖前后端同起 + HeroUI Pro token + 演示库数据,脆性高)。

## 跑法

一键(建库 + 起前后端 + 冒烟 + 收摊):

```bash
cd web
bunx playwright install chromium   # 首次:装浏览器
./e2e/run-smoke.sh                  # 默认后端 4010 / 前端 3010(避开主 checkout 4000/3000)
```

对已经起好的栈跑(自己起后端 + `bun run dev`,或指向远端):

```bash
cd web
E2E_BASE_URL=http://localhost:3000 npx playwright test
# 若管理动线要直连后端(绕过 vite 代理):再加 E2E_GRAPHQL_URL=http://localhost:4000/graphql
```

## 场景(一条,五断言)

setup(`global-setup.ts` → `helpers/admin-flow.ts`)以**超管走真实 GraphQL 管理动线**
建「演示会计」:建角色 → `syncSysRolePermissions` 只授 `acc.bank_account:read` →
`createSysUser`(返回一次性密码)→ 指派角色 → 指派公司 → 登录取 token。**动线本身即断言**
(任一 mutation 失败即整轮红)。跑完 teardown 清理,演示角色/用户不进迁移种子。

spec(`authz-smoke.spec.ts`)以该角色断言:

1. **UI 登录**:演示会计用动线所建账号能登录进工作台,token 落 `localStorage`;
2. **授权页见本司数据**:`/finance/bank-accounts` 出银行账户表格与本司样本账户,无 forbidden;
3. **跨公司隔离**:他司银行账户不出现(演示库单公司时自动跳过);
4. **未授权页被拒**:直连 `/system/users`(无 `sys.user:read`)得「无权限访问」空态,不重定向;
5. **外键列降级**:无 `base.company:read` 时银行账户行的公司等外键列退为纯文本(非链接)。

## 一个架构注记(菜单不是安全边界)

spec 原设想「菜单只含授权模块」,但本前端侧边菜单是**静态数组、不按权限过滤**
(`app/lib/menu.ts` + `app/components/app-shell.tsx`)——这与 spec.md「前端按钮显隐
不是安全边界、执法全在服务端」一致。故前端真正的权限执法面在**页面数据层**
(无权资源表格渲染 forbidden 空态)与**外键列降级**,本冒烟据实断言这两处,不断言菜单过滤。

## nightly 化(后议)

当前为本地/按需跑。若要 nightly:把 `run-smoke.sh` 挂到定时 job(独立于 PR CI),
产物收 `playwright-report/`。先解决脆性来源(HeroUI token 注入、演示库幂等重建)再上,
本节留作复议决策。
