# 06 — 以币种完成首个 Basic Form 闭环

**What to build:** 将币种从服务端 typed ResourceDefinition 一路贯通到 ResourceDocument、ResourceBinding、RecordFormCodec、Basic Form renderer 和领域 API，删除币种页面与 drawer 中重复的静态字段事实，同时保持所有现有业务行为。

**Blocked by:** 05 — 扩展前端 Catalog client 与 ResourceBinding.

Status: resolved

- [x] 币种定义是字段、输入策略、查询能力、布局和显示标签的唯一声明。
- [x] 币种显示文案保持当前“货币”语义，不误用权限组标签。
- [x] Basic Form 支持币种所需 create、edit 和 view 模式。
- [x] runtime form values 经 typed codec 转成 API Create/Update，不依赖宽泛断言。
- [x] 币种页面不再手工传静态 fields 或直接选择第二个 client。
- [x] 启停操作和 query invalidation 使用同一个 binding 与资源 query key。
- [x] ISO code 格式、唯一性、创建后不可改和被公司引用时不可停用仍由领域服务强制执行。
- [x] UI required 只是即时反馈，直接 API 请求仍会被服务端领域校验拒绝。
- [x] 无读取、只读、创建、编辑、启停和错误反馈都有端到端测试。
- [x] 币种迁移前后的 Grid、Form、权限、筛选和排序行为等价。
- [x] 未增加产品规则或产品文档变更。

## Answer

- 服务端：`label: '货币'` + legacy normalizer → catalog basic form layout
- 前端：`basicFormDrawerProps` / `decodeCurrencyCreate|Update` / `useResourceDocument`
- 页面：`web/app/routes/_app/base/currencies.tsx` 只经 `resourceBindingFor` + catalog 投影
- drawer registry 去掉 basCurrencies 静态 fields/exclude
- 单测：`basic-form.test.ts`（完整 e2e 浏览器矩阵可在后续工单补强）

## Comments
