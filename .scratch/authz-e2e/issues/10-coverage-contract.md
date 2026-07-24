# 10 — 完整性收口（豁免清单清零）

**What to build:** expand–contract 的收口：两张豁免清单（世界覆盖豁免、read 白名单豁免）清零或仅剩逐项复核过的带理由档案项。自此新资源进权限目录而不进夹具世界、或声明 read 而缺席表格白名单，CI 即红——矩阵对未来资源自动强制，不再依赖自觉。

**Blocked by:** 04 — 批次A；05 — 批次B；06 — 批次C；07 — 批次D.

**Status:** resolved

- [x] 世界覆盖豁免清单为空，或仅剩带书面理由项且逐项复核确认合理
- [x] read 白名单豁免清单同上
- [x] 工程约定文档补一条：新资源接入需同步补夹具世界构造函数与应得集声明（与既有"新资源多处注册"清单并列）
- [x] 全量矩阵在 CI 的耗时可接受；若超预算，分片方案在本票内解决而非降覆盖

## Comments

- **世界覆盖豁免清单**:批次D(工单07)落地时已随最后一项一并清空,`coverage_exempt/0`
  现返回 `%{}`。权限目录 54 资源全部有构造函数(读写矩阵各 54 + 试点),新资源
  进目录而漏构造函数,`authz_matrix_coverage_test` 的目录 diff 守卫即红。
- **read 白名单豁免清单**(`whitelist_exempt/0`):保留 4 项档案,逐项复核合理——
  均为「有 read 权限点但无表格页」的资源,读出口另有形态且已经矩阵覆盖:
  - `sys.role_permission`:授权行无独立表格页,读面=角色权限矩阵面板(list 查询 sysRolePermissions);
  - `sys.setting` / `acc.setting` / `sales.setting`:设置类单行表,read_one 查询,无表格页。
  这 4 项都经 `Gql.read_endpoint!/1` 的回落分支(分页 list / read_one)进读矩阵,
  非「漏覆盖」而是「读出口形态不同」。守卫的 stale 检查确保它们仍确实缺席 GridMeta
  白名单(一旦补了表格页就必须删豁免,否则红)。
- **工程约定**:`backend/AGENTS.md`(= CLAUDE.md)权限节补一条——新资源进目录必须
  同步补 `world.ex` 的 builders/write_inputs/visibility,与既有「新资源多处注册」并列。
- **CI 耗时**:全量矩阵(读 54 + 写 54 + R3 8 + 覆盖守卫 3)并入 synie_web 测试,
  整个 web 套件 ~6.5s(matrix 增量极小,shared-owner Sandbox 单建世界复用全模块)。
  远未触及需分片的预算,不做分片。随现有 CI 后端 job 每次 push/PR 常跑。
