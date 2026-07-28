# Meta 契约快照

本目录不再存放快照文件。

- **现行产品后端**：Meta 由 `server/src/platform/meta` Registry 在运行时提供；类型与 wire 以 `ApiType` / 各域 meta 注册为准。
- **历史 Go 实现**：包内 `testdata/meta/` 快照随 `server-go/` 删除；可用 git tag `server-go-final` 恢复整树考古。
- **authz 等 fixtures**：见 `contracts/fixtures/`。
