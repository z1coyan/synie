# 03 — 以 sealed Catalog 并行投影 v1 与 v2

**What to build:** 让所有现有资源进入同一个启动期 Catalog，并在不破坏旧前端的情况下，从同一 ResourceDefinition 同时投影旧 Grid/Form 与 v2 ResourceDocument。无效引用在服务启动阶段失败，而不是进入运行时。

**Blocked by:** 02 — 扩展 ResourceDocument v2 共享契约.

Status: resolved

- [x] Registry 具有 register、seal、project/read 生命周期，seal 后不能继续注册。
- [x] 存量 ResourceMeta 可经明确标记的 legacy normalizer 进入 Catalog，新资源不能使用该入口。
- [x] typed resource authoring 能在编译期拒绝本资源 list、form 和 discriminator 的无效字段引用。
- [x] seal 校验资源名、显示标签、权限、字段、枚举、lookup、外键、布局、commands 和打印引用。
- [x] 同一 Meta 响应保留旧 name/Grid/Form，并增加 `catalog` v2 文档。
- [x] 旧 Grid 与 v2 文档都从同一服务端定义投影，不手工双写字段事实。
- [x] Actor 无目标资源读取权时，Grid 保持当前只读 ID 降级，Basic Form 不产生可编辑 ID 输入。
- [x] 投影后的 fields、list、form、lookup 和 references 保持引用闭包。
- [x] write-only 字段描述可安全用于输入，但值不进入 list、read、view 或 print。
- [x] 全部基线资源成功 seal，并报告 typed 与 legacy 数量。
- [x] 旧前端和现有 Meta 快照在本切片完成后保持通过。
- [x] Catalog 没有通用 create、update、delete 或 SQL 保存入口。

## Answer

- Registry：`register → seal → buildDocument`；生产 `index.ts` 与 `createSealedResourceRegistry` 均 seal（97 legacy）。
- Legacy normalizer：`legacy-normalize.ts`；typed 辅助：`define-resource.ts`（`catalogSource: 'typed'`）。
- 双投影：`buildDocument` 同时返回 v1 grid/form + `catalog` v2；外键无目标权时 Grid 降级、basic form 移除字段。
- 测试：`catalog-seal.test.ts` + 特征测试扩展。

## Comments
