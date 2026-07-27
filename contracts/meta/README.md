# Meta 契约快照

本目录不再存放快照文件。运行时 Meta 的稳定 wire 快照（2026-07 迁移期从运行中的
Elixir 应用捕获）现行的唯一事实源是 **server 模块内各消费包的 `testdata/meta/`**：

- 域资源：`server/internal/domain/<域>/<包>/testdata/meta/<resource>.<actor>.grid.json`
  （如 `server/internal/domain/trading/order/testdata/meta/salOrders.superadmin.grid.json`）
- 平台资源：`server/internal/platform/<包>/testdata/meta/`（files、numbering、
  printing、settings 等）
- 跨域组合契约（库存、供销对账）：`server/cmd/synie/testdata/meta/`
- GraphQL 表面冻结等跨域参考捕获：`server/cmd/synie/testdata/surface/`

各包 `meta_test.go` 以包内相对路径读取快照并 `DeepEqual` 对拍；快照缺失或读取
失败即 `t.Fatal`（fail-closed），不允许 Skip——容器化或剥离仓库上层目录运行
`go test` 时契约保护必须依然生效。

约定：**新增资源必须同时落快照**——把参考实现（或迁移期 Elixir 捕获）的
`gridMeta` wire 输出写入该资源归属包的 `testdata/meta/`，并在该包 `meta_test.go`
中对拍。快照必须来自真实 wire 捕获或 Go Registry 的确定性输出，禁止把迁移规划
中的“示意 JSON”当 parity oracle。
