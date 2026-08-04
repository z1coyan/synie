# 04 — 执行适配三件套与封路测试

**What to build:** 把内核接到执行面：(1) `guard(resource, action)` Hono 中间件——查 sealed registry 确认动作存在（含 anyOf/allOf 形态）、调 decide、Permit 入 ctx；错误语义唯一规则（码 miss=forbidden，行级 miss=not_found）。(2) RowFilter AST → SQL 编译器（db 适配层），`listFromSource` v2 直接收 Permit 自动 AND（消灭 `empty` 早退义务与 NULL-admitting 手滚）。(3) `loadAuthorized(permit, id, { forUpdate? })` 共享单记录加载。(4) 写侧守卫：create 公司校验 + `owner_dept_id` 盖章（声明 stamped 才盖）。(5) 特征化封路测试：`modules/**` 禁止 import `requirePermission`/`hasPermission`/`companyScopeWhere`/`canAccessCompany`（豁免清单带理由，随扫荡清零）。本工单不迁移业务模块（试点在 06-08）。

**Blocked by:** 02, 03

**Status:** ready-for-human

- [x] guard 中间件 + systemPermit 路径
- [ ] 打印等客户端提供 prefix 的入口改为目录解析后取 Permit —— **机制已就位、printing 路由本体未迁，随工单 09**
- [x] compileRowFilter：company（含 nullable）/deptTree/dept/self 编译 + 参数化；granted 编译分支显式抛「未实现」
- [x] listFromSource v2 / loadAuthorized（FOR UPDATE 折叠）落 db 层，旧签名保留至扫荡完成
- [x] create 写侧守卫与盖章助手
- [x] 封路测试挂 CI（初始豁免=全部存量模块，扫荡逐批削减）
- [x] 内核↔SQL 编译集成测试（含空公司集、无部门、nullable 公司列）

## Comments

2026-08-05 实施：guard/permitOf 在 `platform/authz/enforce.ts`；RowFilter→SQL 在 `db/authz-sql.ts`
（via 链编译为逐层 EXISTS）；`listAuthorized` 在 `db/list.ts`、`loadAuthorized`/`findAuthorized`/
`assertCompanyWritable`/`ownershipStamp` 在 `db/load.ts`；封路清单 `src/modules/authz-firewall.test.ts`
（初始豁免 46 个模块文件，含「无僵尸项」断言强制迁完即删行）。
**打印入口的目录解析改造留给工单 09**——本工单只提供机制（guard 从 sealed registry 解析动作、
客户端提供的 prefix 不再直接进码），printing 路由本体未迁。

两处 review 抓到的实现错误已修：
1. **全局资源曾被公司边界清空**——`compileRowFilter` 早退只看 `company === 'none'`，
   没看资源有没有公司列，零公司授权的用户读币种/用户等 global 资源会拿到空集。
   现按绑定决定边界是否施加（spec §5「全局资源：只有码级判定」），回归用例进
   `test/authz-enforce.postgres.test.ts`。
2. **guard 挂在 requireAuth 之前会 500 而非 401**——`permitFor` 现显式判空并抛 unauthorized。

另：`RowFilter.company` 去掉了 spec §6 写的 `nullable` 字段。可空性是**表事实**，
零表知识的内核拿不到，实际由 `ResourceMeta.authz.nullable` 在编译期提供；
留在 AST 里恒为 false、无人读，是个会误导人的诱饵字段。
