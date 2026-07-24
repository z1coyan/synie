# 08 — R3 出口场景集（文件下载 · 打印导出）

**What to build:** 两个绕开 GraphQL 的 REST 数据出口的越权场景集（定向场景，非全量矩阵），复用夹具世界并为其补充文件/附件/打印模板条目。这是历史上真实出过修复的高危面（打印模块审计修复的事故形态），本票为其上回归保险。

**Blocked by:** 02 — 矩阵内核 tracer bullet；07 — 夹具世界批次D（可打印资源=销售单据）.

**Status:** resolved

- [x] 裸文件：上传者本人可下载、他人被拒、超管可下载（既有 FileControllerTest 已覆盖,见下）
- [x] 附件：跨公司下载被拒、无宿主 read 码被拒、有码同司可下载（正向对照）（既有 FileControllerTest 已覆盖）
- [x] 补挂：非上传者本人把裸文件挂宿主被拒
- [x] 打印导出：跨公司单据被拒、无 print/export 码被拒、可打印清单外资源被拒、有码本司成功产出二进制（正向对照）
- [x] 世界新增条目（文件/附件/打印模板）进覆盖表，完整性守卫认账
- [x] 全部走真实 HTTP 管线（带 token），进 CI

## Comments

落地:`apps/synie_web/test/synie_web/authz_r3_outlets_test.exs`(8 断言,复用 World)。

- **分工去重**:裸文件下载(上传者/他人/超管)与附件下载(跨公司/无宿主码/
  有码同司正向)已由 `SynieWeb.FileControllerTest` 的「GET /api/files/:id
  宿主可见性授权」describe 全覆盖(正是 #41 修复的回归网,共 9 条)。本套件
  不重复,只补 #41 网未覆盖的两处出口——补挂端点与打印导出端点。
- **补挂**(`POST /api/files/:id/attachments`):非上传者(有 sys.file:read +
  宿主读码 + 同公司,唯一差别是不是上传者)补挂裸文件到公司甲凭证 → 403
  「仅能挂接本人上传的文件」;正向对照:上传者本人补挂成功。堵「补挂洗白越权下载」。
- **打印导出**(`POST /api/print`):
  - 正向:sales.order:read+export + 公司甲 → 导出甲司订单成功,产出 xlsx 二进制
    (export 走 Renderer.render_sheets,不依赖 LibreOffice,进 CI 不脆);
  - 跨公司:授甲主体导出乙司订单 → load_records 经 actor 授权读取时不可见 → 422;
  - 无码:仅 read 码 → export/print 各 403(check_perm 门);
  - 清单外:printable_resources 恰为全 54 目录资源,故用目录外字符串
    `bogus.resource` → 422「不支持的资源类型」,证明反射面不被扩大;
  - 未登录 → 401。
- **世界条目**:打印模板(sales.order)、模板文件、裸文件上传源均在 World/setup;
  可打印单据=批次D 的已审核含明细销售订单(两司各一张),完整性守卫认账。
- 坑:export 正向主体须同时持 `sales.order:read`(load_records 经 actor 读单据)
  与 `sales.order:export`(check_perm),二者独立不互含。
