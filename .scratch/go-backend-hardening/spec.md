# Go 后端迁移质量收尾（go-backend-hardening）

## 背景

Elixir→Go 迁移已完成 100/100 资源盘点与业务链路落地（见 `docs/migration/` 与 `.scratch/migration/`）。2026-07-27 的全量代码评审确认架构骨架健康（contract-first、meta 注册表、引擎模式、apierror/authz/audit 三件套），但存在三类遗留：

1. **制度缺口**：CI 无 Go server 门禁，目标栈回归靠自觉；Meta 契约测试在快照缺失时 Skip（fail-open）。
2. **迁移期复制债**：HTTP 层三套 handler 风格并存、helper 散落居无定所；领域层 PG 错误映射/分页/List 脚手架/pgtype 助手/meta 构建助手均有多份复制；三态可选字段双轨制（`**string` vs `OptionalString`）。
3. **产品缺口**：打印执行面在 Go-only 栈下断链（前端仍请求 Elixir 时代的 `/api/print` 暗管）；行情定时调度器未迁移；打印字段目录与 meta.Registry 两套资源描述并行。

本目录工单按依赖排序编号，阻断关系见各工单 `Blocked by` 行。收敛类工单按宽重构纪律执行：机械移动、逐批保持绿测、不改变行为。

## 工单一览

| # | 工单 | 阻断 |
|---|------|------|
| 01 | CI 增加 Go server 门禁 | 无 |
| 02 | HTTP/领域层正确性修正包 | 无 |
| 03 | Meta 契约测试 fail-closed 化 | 无 |
| 04 | HTTP 层 helper 收敛与 Server 瘦身 | 无 |
| 05 | 三态可选字段统一为泛型 Optional[T] | 04 |
| 06 | 领域层公共化：dberr + 泛型 List 执行器 + meta 助手上移 | 无 |
| 07 | 测试基础设施沉淀（testutil + CI 跑 PG 集成测试） | 01 |
| 08 | 审计脱敏自动化 | 无 |
| 09 | 文件 owner 注册表改注册式 | 无 |
| 10 | 打印执行面补齐 | 无（开工前须核对 print-engine 等既有 spec 边界） |
| 11 | 行情定时调度器迁移 | 无 |
| 12 | 打印字段目录并入 meta.Registry | 10 |

## 非目标

- 不引入 repository/Unit-of-Work 抽象（评审结论：引擎 + 调用方持事务的尺度已恰当）。
- 不动 `sideSpec` 表驱动等已被验证优于原版的设计。
- 不删除 `backend/`（Elixir 参考实现按迁移规划 D.9 暂留）。
