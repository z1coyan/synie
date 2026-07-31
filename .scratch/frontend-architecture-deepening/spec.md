# 前端深模块改造

## 背景

前端架构审查确认五处高价值改进：

1. `ResourceBinding` 未完全拥有 reader、查询缓存身份与失效语义。
2. 复杂单据页面仍自行编排表头、明细和阶梯持久化。
3. Presentation Extension 的 Drawer、审核与预览实现集中在全局 registry。
4. Hono transport 的响应解析与 wire codec 在资源 adapter 间重复。
5. 部分路由测试读取源码并断言 implementation 形状。

## 目标

- 把复杂行为放进深 module，通过小 interface 为调用者提供 leverage。
- 把变更、错误与验证集中到拥有业务知识的 module，提升 locality。
- production Hono adapter 与测试用 in-memory adapter 穿过同一 seam。
- 测试以 module interface 的可观察行为为主，少量架构守卫只验证依赖方向。

## 非目标

- 不把 Resource Catalog 扩张为通用写入引擎。
- 不引入 GraphQL、OpenAPI codegen 或另一套请求路径。
- 不改变卡片模式仍由 `SynieDataGrid` 内部实现的既有取舍。
- 不在缺少业务语义时强行把所有单据塞进一个通用保存 abstraction。

## 交付顺序

第一波并行建立三个业务 seam：

- ResourceBinding 与 cache identity。
- 各业务聚合的 Aggregate Draft Adapter。
- 与资源业务同地的 Presentation Extension。

第二波在稳定 seam 上完成：

- typed Hono transport 与 wire codec。
- interface 行为测试迁移及源码形状测试清理。

## 验收

- `bun run typecheck`、`bun run check` 通过。
- `bun test` 通过，或仅保留与本改造无关且有明确记录的既有失败。
- 关键 module 至少有 production adapter 与 in-memory adapter/测试。
- 页面不再自行猜测 `gridRows` 查询键。
- 已迁移的复杂单据页面不再自行循环执行表头/明细持久化。
- 全局 Presentation Extension registry 退化为薄装配，未知资源仍 fail-closed。
- `CONTEXT.md` 与对应架构/产品文档同步更新。

## 完成记录

2026-07-31：五项改造均已落地。ResourceBinding 已拥有规范 Adapter 与缓存身份，生产
Grid/Drawer/EditableTable/远程选择器不再注入具体 client；所有命令 target 共享 effects
preflight 与精确失效。六个 SCM 聚合头改经 Aggregate Draft，后端单事务保存、严格完整
快照 schema、一致读与原授权差异校验均有测试。Presentation 与 preview 已按业务共置，
Hono response/wire codec 已集中，14 份源码形状测试由 interface 契约与集中架构守卫替代。

随机顺序组合测试还发现并消除了全局 binding registry 的顺序依赖：生产 resolver 始终
恢复规范 binding，custom/in-memory 测试通过局部 resolver 注入，不再污染同名生产资源。

## 最终验证

- Web：177 pass / 0 fail（1804 assertions），typecheck、组件 check 与 production build
  均通过。
- Server：205 pass / 0 fail；默认环境另有 158 个数据库集成用例 gated skip。
- Shared：14 pass / 0 fail。
- 隔离临时 PostgreSQL 完整执行迁移后，transaction、订单/报价/发货聚合草稿 30 pass /
  0 fail；容器已清理。
- registry 六文件组合以随机种子 1–20 重排均 37 pass / 0 fail；`git diff --check`
  通过。
