# 共享资源 seam 去 GraphQL 回退

Status: resolved

## 范围

- SynieDataGrid、meta、CSV、行/批量动作。
- SynieRecordDrawer。
- RemoteSelect。
- SynieEditableTable/use-doc-items。
- 资源 registry 默认解析与 fail-fast。

## 完成定义

生产路径不再调用 `gqlFetch`；调用方通过显式 client 或 registry 获得 ResourceClient；未知资源抛出带资源名的明确错误；相关单元/契约测试通过。

## Comments

### 2026-07-26

已合入：`refactor(web): 收口共享资源 REST seam` 等提交。
