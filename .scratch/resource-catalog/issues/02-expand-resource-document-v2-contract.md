# 02 — 扩展 ResourceDocument v2 共享契约

**What to build:** 增加一份强类型、可运行时校验的 ResourceDocument v2 契约，同时保留现有 Grid/Form DTO。这个 expand 切片只增加新形状，不要求旧调用方迁移，因此仓库在完成后仍保持兼容。

**Blocked by:** 01 — 锁定现有 Meta 行为并统一资源注册.

Status: resolved

- [x] v2 文档包含 schema version、资源名、独立显示标签、权限前缀、有效 capabilities、字段、lookup、列表、Form 和 commands。
- [x] 字段使用判别联合表达 scalar、UUID、JSON、enum、enum array、普通外键和多态外键。
- [x] 字段 input policy 是 required、readonly、create-only、clearable 和静态初值的唯一事实源。
- [x] 字段能表达 readable 与 write-only，且 write-only 值不进入读取契约。
- [x] 查询能力直接复用现有 Filter DSL 和 Sort contract，不增加第二套操作符。
- [x] Form 明确区分 basic、extension 和 none；Basic FormMeta 只含静态布局。
- [x] command 明确区分 collection、row、bulk 和 row-or-bulk target，并携带 requiredCapability。
- [x] 兼容响应类型能同时承载旧 Grid/Form 和新的 `catalog` 文档。
- [x] runtime decoder 拒绝未知 schema version、非法字段 kind、断裂布局引用和非法 command target。
- [x] shared 类型检查和契约测试全部通过。

## Answer

- 类型：`packages/shared/src/resource-document.ts`
- Decoder：`packages/shared/src/resource-document-decode.ts`
- 契约测试：`packages/shared/src/resource-document.test.ts`
- `ResourceMetaDocument` 增加可选 `catalog?: ResourceDocument`

## Comments
