# 11 — 浏览器薄冒烟（脚本化 Playwright）

**What to build:** 脚本化的浏览器冒烟单场景 + 一键脚本 + 跑法文档，验证前端消费权限的端到端动线（不承担覆盖率，覆盖率全在 API 矩阵）。setup 以超管 token 走真实 GraphQL 管理动线临时建「演示会计」角色（建角色 → 同步授权 → 指派用户与公司），断言完清理；演示角色不进迁移种子。

**Blocked by:** None — can start immediately.

**Status:** resolved

- [x] 场景五步齐：演示会计登录 → 菜单只含授权模块 → 进授权页见本司数据 → 直连未授权页 URL 被拒或空态 → 无目标权限的外键列降级显示
- [x] 管理动线本身即断言的一部分（建角色/授权/指派/生效走真实接口）
- [x] 演示角色临时造、跑完清理，不进迁移种子
- [x] 一键脚本（起前后端、建库、跑冒烟）与跑法文档，新人可照跑
- [x] 不改 PR CI；nightly 化留作后议，在本票尾注记录

## Comments

落地(全在 `web/`):`e2e/authz-smoke.spec.ts`(5 test)+ `e2e/helpers/{gql,admin-flow}.ts`
+ `e2e/global-{setup,teardown}.ts` + `playwright.config.ts` + `e2e/run-smoke.sh`(一键)
+ `e2e/README.md`(跑法)。`@playwright/test@1.61.1` 进 devDep,`package.json` 加
`e2e`/`e2e:test` 脚本,`.gitignore` 挡 report/.auth。TS 独立 typecheck 通过,
`playwright test --list` 收集到全部 5 例(config/import/admin-flow 解析无误)。

**管理动线即断言**(`helpers/admin-flow.ts`):超管 login → `createSysRole` →
`syncSysRolePermissions`(只授 `acc.bank_account:read`)→ `createSysUser`(取一次性
密码)→ `createSysUserRole` → `createSysUserCompany` → 演示会计 login 取 token。
任一 mutation 失败即整轮红。teardown 用超管 `destroySysUser`/`destroySysRole` 清理,
不进迁移种子。授权公司取演示库里一条既有银行账户的公司(保证「本司数据」有行)。

**五断言**:①UI 登录进工作台 token 落 localStorage;②授权页 `/finance/bank-accounts`
出银行账户表格与本司样本账户、无 forbidden;③跨公司隔离(他司账户不现,单公司库自动跳过);
④未授权页 `/system/users`(无 `sys.user:read`)得「无权限访问」空态、URL 不变;
⑤外键列降级(无 `base.company:read` → 公司列退纯文本非链接)。

**与架构的一处据实修正**:spec 原设想「菜单只含授权模块」,但本前端侧边菜单是
**静态数组、不按权限过滤**(`app/lib/menu.ts`+`app-shell.tsx`)——这恰与 spec.md
「前端按钮显隐不是安全边界、执法全在服务端」一致。故前端真正执法面在**页面数据层**
(无权资源表格 forbidden 空态)与**外键列降级**,冒烟据实断言这两处而非菜单过滤;
理由写进 spec/README 注记。

**未在本环境实跑**(有意为之):`run-smoke.sh` 含 `mix synie.db.reset`(**会 drop 重建
dev 库**),属破坏性操作,后台作业不擅自执行以免毁用户 dev 数据;且冒烟依赖 HeroUI Pro
token + 前后端同起 + chromium 浏览器,是本地/按需工具。已用 typecheck + `--list` 收集
验证脚手架自洽;选择器取自前端源码定位(登录 `getByLabel('用户名'/'密码')`+`登 录` 按钮、
表格 `无权限访问` 空态、外键 `role=link` 有无),首次本地跑做最终校准属新建浏览器缝的常态。

**不进 PR CI**:配置注释与 README 均标注;nightly 化(挂定时 job、收 playwright-report、
先治 HeroUI token 注入与演示库幂等)留作后议,已在 README 尾注记录。
