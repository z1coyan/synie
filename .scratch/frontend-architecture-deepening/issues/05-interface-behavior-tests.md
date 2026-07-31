# Interface 行为测试迁移

Status: ready-for-agent

## 目标

把读取 `.tsx` 源码并断言 import、prop、registry 数量的测试替换为穿过 module interface 的行为测试；架构规则由少量独立守卫表达。

## 验收

- 修复当前 quotation REST contract 的源码计数失败。
- 行为测试断言可观察结果，不断言 implementation 形状。
- 删除被新 interface 测试覆盖的浅测试。
- 如需依赖方向检查，使用明确且集中维护的架构守卫。

## Comments

- 等前三个 module interface 稳定后分派，避免测试对过渡 implementation 固化。
- 2026-07-31 调研：14 个路由测试读取源码，约 306 个 `toContain`/`not.toContain`/`matchAll` 形状断言；当前唯一失败为 quotation audit 配置正则期望 13、实际 12。新测试应复用 `catalog.test.ts` 与 `presentation.test.ts` 已证明的 interface 测试形态。
- 2026-07-31：Presentation Extension interface 稳定后分派给 `presentation_locality`；当前全 web 测试 200/201，剩余失败为 mfg 测试对源码引号格式的断言，正好验证迁移必要性。
- 2026-07-31：14 个路由源码读取测试与旧 contract-invariants 已删除，替换为唯一 architecture guard、96 资源 ResourceBinding runtime 契约、setup/todo facade、CSV 与 Presentation interface 行为测试；目标 26/26 通过。
- 2026-07-31：新增 Aggregate Draft、typed response/wire、Command effects、Preview 与 AuditDoc cache prefix 行为测试；除唯一集中 architecture guard 外，不再有测试读取生产源码断言 import、prop 或 registry 数量。
- 2026-07-31：随机顺序组合回归复现并修复测试间 binding registry 污染；命令与 Grid 行为测试使用局部 resolver，生产契约不再依赖测试文件执行顺序。
- 2026-07-31：最终 Web 177/177（1804 assertions），registry 随机种子 1–20、全仓 3/3 typecheck、组件 check、production build 与 diff check 均通过；最终独立审计无 blocker。
