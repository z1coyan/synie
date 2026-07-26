# Meta 契约快照

运行时 Meta 的稳定 wire 快照放在本目录。快照必须来自正在运行的参考实现或 Go
Registry 的确定性输出，禁止把迁移规划中的“示意 JSON”当 parity oracle。

`basCurrencies.grid.json` 与 `basCompanies.grid.json` 于 2026-07-25 从运行中的
Elixir 应用通过 `SynieWeb.Schema` 执行 Appendix A 的 `gridMeta` 查询捕获。Go
Registry 测试按 JSON 语义与这些真实 wire 快照对拍。
