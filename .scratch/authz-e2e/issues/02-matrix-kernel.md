# 02 — 矩阵内核 tracer bullet

**What to build:** 权限矩阵扫描的端到端骨架，在两个试点的公司隔离资源上全绿、可演示。包含三件套：①双公司夹具世界骨架——公司甲/乙、每资源构造函数注册表、应得集声明机制（默认"公司匹配即应得"、支持每资源显式覆盖）、覆盖豁免清单；②合成极值主体生成器——由权限目录反射生成无码者、最小 read+公司甲、同码只授公司乙、持码零公司授权、`all_companies`、`super_admin` 六种形态；③真实 HTTP 管线读侧扫描——带 token 打 GraphQL 的 list 与按 id 查询（聚合列随 list 断言），双向断言"可见集恰好等于应得集"。

**Blocked by:** None — can start immediately.

**Status:** resolved

- [x] 夹具世界：公司甲乙 + 两个试点资源在两司各一条合法记录，构造函数绕过授权建数
- [x] 应得集声明机制可用，矩阵以声明为 oracle，不在断言里重新实现过滤逻辑
- [x] 完整性守卫：权限目录清单 diff 世界覆盖表，未覆盖资源必须在豁免清单；「声明 read 必在表格元数据白名单」守卫同机制同豁免形式
- [x] 极值主体由权限目录反射生成，不手写权限码清单
- [x] 读侧扫描走真实 HTTP 管线（token 验证在射程内），含未登录请求全拒断言
- [x] 双向"恰好等于"断言；失败信息点名 资源 × 主体形态 × 方向（正/负）
- [x] 解决两处实现皱褶（SQL Sandbox 与 setup_all 相性、umbrella 下测试支撑代码的共享落点），选定方案记入测试模块文档
- [x] 试点资源矩阵全绿，进现有后端 CI job

## Comments

落地（全部在 synie_web，web 依赖 core）：

- `test/support/authz_matrix/world.ex` — 双公司世界：构造函数注册表（试点
  acc.gl_journal / inv.warehouse）、应得集声明（默认 :company/:global +
  visibility_override 函数子句挂特例）、覆盖豁免清单（52 项按批次A-D 注理由）、
  read 白名单豁免（4 张单行设置/授权行）。
- `test/support/authz_matrix/subjects.ex` — 六种极值主体，权限码经
  `Registry.catalog()` 反射（`action_code!/2` 不在目录即抛错），签真实 token。
- `test/support/authz_matrix/gql.ex` — POST /graphql HTTP 载具（不用 Absinthe.run）。
- `test/synie_web/authz_matrix_read_test.exs` — 读矩阵（list + 按 id + count 聚合，
  双向恰好等于；匿名/无码全拒）。
- `test/synie_web/authz_matrix_coverage_test.exs` — 两张完整性守卫（含豁免失效检查）。

两处皱褶的定案（已记入模块文档）：

1. Sandbox × setup_all：世界每模块建一次，`Sandbox.start_owner!(shared: true)` 专职
   owner 进程持有连接，模块 async: false（sync 模块串行，不与 async 的 :manual 打架），
   退出显式恢复 :manual。
2. umbrella 落点：世界构造器整体放 synie_web/test/support；不反挂 core 的 test/support
   进 web 的 elixirc_paths（双重编译模块冲突），公司/币种小夹具允许与 AuthzFixtures 重复。

已做正负两方向变异验证：oracle 高估→正向断言点名；oracle 低估→负向断言点名泄露 id。
