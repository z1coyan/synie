# 12 — 打印字段目录并入 meta.Registry

**What to build:** 打印字段目录不再是与资源 meta 平行的第二套资源描述。迁移期从 Elixir 机械捕获的字段目录（go:embed 内嵌快照）完成历史使命，打印可选字段改由 meta.Registry 单一事实源派生；「字段在 meta 改了、打印目录忘了改」这类漂移从结构上不可能再发生。这是迁移债清偿工单，实施前需先确认打印执行面（#10）已稳定消费目录，避免两次改动互相踩踏。

**Blocked by:** 10 — 打印执行面补齐（目录的消费方稳定后再换定义来源）

**Status:** ready-for-agent

- [x] meta 字段模型补齐打印目录所需的表达缺口（循环区、头字段分组等，若有）
- [x] 打印字段目录由 meta.Registry 派生，机械捕获快照删除
- [x] 打印可选字段集与迁移期捕获快照对拍通过（等价性有测试证明，再删快照）
- [x] 「对齐旧契约」类过渡测试随快照一并清理
- [x] 相关 ADR 更新（打印字段目录迁移决策标记为已完成/被取代）

## Result

### 差距分析（快照相对 meta.Registry 多表达了什么）

- **标签无信息**：快照 60 资源 / 1223 头字段 / 28 循环区 / 1060 循环字段，所有 `label` 恒等于 `name`（机械捕获），头字段分组不存在。
- **循环区定义**：快照的 28 个循环区（items/lines/transactions/children 等）是 meta 唯一真正的表达缺口；循环目标子表（salOrderItems 等）已有独立 meta，但头→子表的归属关系未表达。`nestedLoops`（循环目标自身的循环，如报价条目的 tiers）同样缺失。
- **头选择器**：同一权限前缀下常有多个 meta 资源（头+子表，如 purchase.order 有 4 个），哪个是打印头未表达。
- **字段口径**：快照 = 资源标量（含计算/投影字段，剔除 id/时间戳/敏感字段/`*_id`）+ belongs_to 一层展开（`relation.目标标量`，目标侧只取物理属性、不含计算字段）+ 封闭枚举多态 `party.name`；开放字符串多态（voucher）不展开；8 个子表资源的多态外键只暴露原始 `party_id` 列。meta 有 Ref/Variants 可支撑绝大部分，但「计算/投影字段」「子表 party_id 原始列」「仅打印可见字段」三个口径缺口需补齐。
- **执行面消费**：打印执行面（service/render/docbuilder）只消费 catalog 的 `Get`（资源存在性）与 `ValidatePlaceholders`（字段集 + nestedLoops 分类文案），接口不变即可平滑换源。

### 派生机制（单一事实源 = meta.Registry）

- meta 最小增量（`internal/platform/meta/types.go`）：
  - `ResourceMeta.PrintHead`：权限前缀多候选时显式标记打印头（25 处）；单候选自动认定；`ReadPermissionsAny` 投影视图不参与。
  - `ResourceMeta.PrintLoops []PrintLoopMeta{Name, Resource}`：循环区声明（28 处，含子表上的嵌套声明——nestedLoops 由目标自身 PrintLoops 派生，复用既有资源关联，无第三套关系描述）。
  - `FieldMeta.Calculated`：计算/投影字段，关联一层展开时跳过（21 处字段组）。
  - `FieldMeta.PrintRawID`：子表多态外键只暴露原始 `party_id`（8 个子表资源）。
  - `FieldMeta.PrintOnly`：仅打印可见、不进 Grid 文档（`has_children` ×3、`accBillHoldings.label`）。
- 派生实现：`printing/catalog.go` `NewFieldCatalog(registry)`，对外接口（Resources/Get/ValidatePlaceholders 及中文分类文案）零变化；main.go 注入 registry；iam 的 `sysRolePermissions.role_id` 补了缺失的 `sysRoles` Ref（meta 表达缺口，Grid 同步受益）。

### 对拍与差异登记

- 删除前对拍测试（`catalog_parity_test.go`，随快照一并删除）：派生目录与捕获快照**逐资源、逐字段、逐循环区、逐 nestedLoops 完全一致，60/60 资源，零差异**。无需登记差异的条目：所有表面差异都归结为上述口径规则（技术列/敏感字段排除、Calculated 跳过、voucher 不展开、PrintRawID），经 meta 标注后消平，而非「派生为准放行」。
- 快照 `field_catalog.json` 与 go:embed 已删除；`catalog_test.go` 中对捕获快照的契约测试替换为合成 Registry 的派生单测 + `catalog_registry_test.go`（真实 Registry 结构断言：60 资源、sales.order 头/循环字段、nestedLoops、确定性）。

### 文档

- ADR `2026-07-25-go-print-field-catalog-migration.md` 标记为已完成（快照机制被取代），追加后续一节记录派生口径。
- `CONTEXT.md` 打印模板/模板占位符条目同步为「自 meta.Registry 派生」口径；产品文档《系统管理》打印模板篇同步。

### 验证

- 对拍测试通过后才删除快照；`gofmt` 已跑。
- `go test ./internal/platform/printing/... ./internal/platform/meta/... ./internal/app/metaregistry/...` 全绿。
- 全套 `go test ./...`（带 SYNIE_TEST_DATABASE_URL）通过。注：`internal/platform/files` 的 `TestPostgresAttachmentCompanyScopeIsFailClosed` 在全套并行运行时偶发「没有默认接入点」——系既有打印测试 fixture 切换默认存储接入的竞态（fixture 为本工单之前代码），与本改动无关，单包运行稳定通过。
