# 03 — Meta 契约测试 fail-closed 化

**What to build:** Meta 快照对拍测试在任何运行环境下都提供真实保护：快照文件迁回仓库内固定位置（`contracts/meta/` 或 server 模块内 testdata，二选一并写清约定），快照缺失时测试失败而非跳过——在容器化或剥离仓库上层目录跑 `go test` 时契约保护不再静默失效。同时清理双轨腐化：`contracts/meta/` 的僵尸快照目录与现行 `.scratch` 快照只保留一套；金额链路 golden fixture（`amount_chain.yaml`）要么接入 Go 单测兑现迁移规划「必跑」的明令，要么经 ADR 说明后正式删除。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [x] meta 契约测试的快照路径指向仓库内固定位置，快照缺失时测试 Fail（含容器内运行场景）
- [x] 快照只存在一套事实源，`contracts/meta/` README 约定更新或目录删除
- [x] `amount_chain.yaml` 被单测消费（金额 JSON string、half-up 舍入链路）或被正式移除并留决策记录
- [x] `contracts/fixtures/base/currency.json` 同样处理（激活或删除）
- [x] 全量 meta 对拍测试在迁移后依然通过

## Result

2026-07-27 完成。

**快照唯一事实源 = server 模块内各消费包 `testdata/`**（容器内可独立运行）：

- `.scratch/migration/snapshots/pr-2.*` 全部 138 个快照按资源归属迁入
  `server/internal/domain/<域>/<包>/testdata/meta/`；跨域组合契约（inv* 22 个、
  pr-2.16 供销对账 12 个）迁入 `server/cmd/synie/testdata/meta/`；目录已删除。
- 特殊文件：`sysTodos/sysTodoStates.*.grid-unavailable.json` 随属 systemops 包
  testdata；3 份 `graphql-surface.json` 与 `meta-resolver-surface.json` 无任何测试
  消费（纯迁移参考捕获），统一安放 `server/cmd/synie/testdata/surface/`（加 pr 前缀
  去重）；`hrEmployees.code-input.graphql.json` 随属 hr/employee 包 testdata。
- `contracts/meta/` 的 **13 个**（工单背景所述「14 个」实为 13 个）.grid.json 全部
  迁入消费包 testdata（base/account、base/company、base/currency、base/unit、
  platform/files、numbering、printing、settings），README 重写为现行位置与
  「新增资源须落快照」约定。双轨并合为单轨。
- 18 个 meta 对拍测试改为包内 `testdata/meta/` 相对路径，读取失败一律
  `t.Fatalf(...fail-closed...)`，删除全部 `t.Skip` 退路；已实测移走快照即 FAIL。

**fixture 决策：两个死 fixture 均激活，未删除。**

- `amount_chain.yaml` → 转为 JSON 迁至
  `server/internal/domain/trading/order/testdata/fixtures/amount_chain.json`
  （go.mod 中只有 indirect 的 yaml 库且本次不改 go.mod，故转 JSON），由新测试
  `amount_chain_test.go` 消费。锚点：`item.go` 的金额链三行（amount=qty×price
  Round(2)、basePrice=price×rate Round(4)、baseAmount=amount×rate Round(2)）。
  **实现文件最小改动及理由**：将这三行提取为 `deriveItemAmounts`（行为等价），
  否则该链只能在需要数据库物料快照的 `deriveAndValidateItem` 内触达，无法用纯
  单测锚定 golden。测试断言 half-up（负数远离零）命中、标度位数、JSON string
  wire。注意：Go 的 decimal JSON 序列化去掉末尾零（`-1.0050` 上线为 `-1.005`），
  与 Elixir 定标输出仅表示差异、数值语义一致，故 wire 比对按数值进行。
- `currency.json` → 迁至
  `server/internal/domain/base/currency/testdata/fixtures/currency.json`，由新测试
  `contract_fixture_test.go` 消费：ISO 格式/不可改为无 DB 断言（含 UpdateInput
  无 ISOCode 字段的反射检查）；默认启用、显式停用、ISO 唯一（conflict）、公司
  本币不可停用走真实 PostgreSQL（遵循仓库 `SYNIE_TEST_DATABASE_URL` 门控惯例，
  ISO 码按测试随机后缀隔离并清理）。
- `contracts/fixtures/` 现仅存 `authz/permission_matches.json`（仍被
  `platform/authz/permission_test.go` 消费，未动）。

**验证**：29 个受影响包 `go test -count=1` 全部通过（含 meta 对拍与两个新
fixture 测试）；全部改动 gofmt 干净；未 commit。
