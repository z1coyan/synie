# 资源事实清单（Resource Manifest）：前端双份声明清零

日期：2026-08-07  
状态：已实施（基线 `main` @ b2aa3d8f，聚合单据内核已合入）  
前置：[`2026-08-07-aggregate-document-kernel.md`](2026-08-07-aggregate-document-kernel.md)（聚合草稿 Adapter / ResourceDocument 消费面）

## 背景

前端把 server meta 已声明的事实在代码里手抄第二份，四处并存：

1. **wire 编码清单**：`restTransport` 的 `decimalFields` / `dateTimeFields` / `decimalOptions` 在 `web/app/lib/resources/` 10 个文件 36 处逐字段手列，与 server `FieldMeta.type` 逐字重复；meta 改类型时前端清单静默漂移。
2. **LOOKUP_SEEDS**：`catalog/lookups.ts` 5 份种子与 server 各模块 `meta.lookup` 逐字重复，只为让 RemoteSelect 在 Meta 拉取前不退化。
3. **中文资源名**：`requireWriter` 第三参（38 处）与 toast 文案（54 处）手抄字面量，与 meta `label` 重复。
4. **transports 名单**：web registry 99 项与后端 105 资源无对拍，差集在打开页面时才炸「未注册 ResourceBinding」。

共同根因：这些事实都是 **actor 无关的静态事实**，却只有运行时 `ResourceDocument`（actor 投影、异步拉取）一个载体；同步消费点（transport 写编码、选择器首屏、报错文案）拿不到，只能手抄。

## 决定

**D1 ★ 事实载体：构建期 manifest。** server 从 sealed Registry 派生 actor 无关事实清单，生成 `packages/shared/src/generated/resource-manifest.ts` 入库；前端同步消费。**否决**运行时 ResourceDocument 派生（写路径依赖文档加载时序，缓存未命中只能静默不编码或运行时炸，恰是本波要消灭的静默失败形态；接口测试注入 gateway 时无文档可读）与混合方案（只解决 1/3，种子与同步标签仍需第二载体）。

**D2 ★ 内容边界：只收 actor 无关事实。** 每资源三项：

| 键 | 内容 | 来源 |
|----|------|------|
| `label` | 独立显示标签 | `meta.label ?? permissionLabel`（即 NormalizedResource.label） |
| `lookup` | labelField / searchFields / subtitleFields / defaultSort | 规范化 lookup（seal 校验后的唯一真值） |
| `wire` | `decimal[]` / `date[]` / `decimalZero[]`（apiName 清单） | `FieldMeta.type` + `decimalEmpty` 提示派生 |

actor 投影事实（capabilities、targetUnavailable、行级 authz 维度等）仍由运行时 `ResourceDocument` 唯一承载，不进 manifest；`contracts/meta` 撤快照的理由（投影必须运行时算）与本 manifest 不冲突。

**D3 ★ 生成与漂移对拍。** `server/scripts/generate-resource-manifest.ts` 生成并落盘；server 侧漂移测试重算全量与提交文件逐字节对拍（同 `catalog-seal.test.ts` 计数先例），改 meta 不重跑生成即红。生成物入库（同 `routeTree.gen.ts` / `db:codegen` 先例），web 经 workspace 源码直出消费，无新增构建步骤。

**D4 ★ `FieldMeta.decimalEmpty?: 'zero'`。** 「空值 wire 发 `'0'`」是类型推不出的领域约定（现状仅 `accGlJournalLines` debit/credit 借贷金额），在 server meta 显式声明；缺省空值仍发 `null`。注册期校验：仅 `decimal` 字段可声明。

**D5 ★ 派生规则（超集安全论证）。**

- `type: 'decimal'` → `wire.decimal`：写体中**出现**的键收口为 wire string（`String(value)`；空按 D4 口径）。
- `type: 'date' | 'datetime'` → `wire.date`：写体中出现的 `YYYY-MM-DD` 值转 `T00:00:00Z` ISO datetime；其他值原样。
- 派生清单是手写清单的**超集**（含 readonly 投影列）也安全：转换只作用于输入里出现的键，readonly 字段本不提交；既有转换对已是 wire 形态的值幂等。
- 现状固化：meta `type: 'date'` 的 wire 形态就是 ISO datetime（`docDate`/`postingDate` 先例），本 ADR 把这一隐式约定显式化。

**D6 ★ 消费点改造。**

- `restTransport` 删 `decimalFields`/`dateTimeFields`/`decimalOptions` 选项，写编码按资源名查 manifest；非标准形状资源（手写 transport）可继续显式调用 `decimalWireInput`/`dateTimeWireInput`，视为逃生舱。
- `resolveResourceLookup` 回落链改为：catalog 缓存文档 → manifest → 通用 `name` 兜底；`LOOKUP_SEEDS` 删除。
- `requireWriter(binding, op)` 第三参与页面 toast 文案的中文资源名改读 manifest `label`；与 `label` 不一致的刻意措辞保留手写字面量（逐处甄别，不批量替换语义不同的文案）。
- web 侧契约测试：`registry.transports` 键 ↔ manifest 资源名单对拍，有意无 binding 的资源（`presentation: 'none'` 等）进显式豁免清单——差集从「打开页面才炸」提前到测试红。

## 后果

- 新资源接入前端只需挂 transport 工厂；wire 编码、lookup、显示标签零声明（`资源接入.md` 清单同步更新）。
- 改 server meta 的字段类型/lookup/label 后必须重跑 `bun run -F @synie/server gen:manifest`；漂移测试兜底，不允许手改生成物。
- manifest 与运行时文档的边界即「actor 无关 / actor 投影」；往 manifest 加新键前须回答「这事实随 actor 变吗」。

## 否决 / 非目标

- 否决运行时 ResourceDocument 派生与混合方案（见 D1）。
- 维持「不引入 GraphQL / OpenAPI codegen」（web/AGENTS.md）：本 manifest 是自有 sealed Registry 的内部派生物，非外部契约工具链。
- 不动 `aggregateDraftTransport` 的 `wire?` 注入面（草稿三连的领域 wire 由聚合 ADR 管辖；同源化评估另议）。
- 不做菜单目录构建产物化（web `menu.ts` ↔ server `menu/catalog.ts` 双侧声明）：同模式适用，但角色白名单 sync 校验牵涉数据面，独立小 PR 另议。

## 后续

- 菜单单侧化：**评估后缓议**。web `menu.ts` 与 server `menu/catalog.ts` 的双侧声明已有两个契约测试对拍（`web/app/lib/menu-catalog-contract.test.ts`、`role-menu.integration.test.ts`），漂移即红、不静默；单侧化需让 server 目录成为「从 web 源生成」的构建产物，依赖方向反转（server 构建耦 web 源）而收益仅是省 ~60 行镜像。若未来菜单改服务端下发（按角色动态菜单），再一并单侧化。
- `aggregateDraftTransport` wire 注入与 manifest 同源化评估。
- 类型级 wire 派生（const meta → 精确输入类型）仍继承标准动作内核待办。
