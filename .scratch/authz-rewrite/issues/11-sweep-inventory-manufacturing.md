# 11 — 扫荡：inventory 余量 / manufacturing 余量

**What to build:** 按 08 手册迁移 inventory 余量（物料/分类/单位转换/仓库——多为 global 或轻公司域）与 manufacturing 余量（BOM/工序/工艺模板/模具设计/委外相关——07 已迁需求单/工单/生产入库）。要点：`manufacturing/helpers.ts:requireCreateOrUpdate`（anyOf 形态）改 guard anyOf；mold-design 与物料 1:1 联动的跨资源写走各自 Permit；BOM 全局共享声明 `global`。

**Blocked by:** 07, 08

**Status:** ready-for-agent

- [ ] 两模块余量资源迁移，本地包装删除
- [ ] 相关集成测试全绿；封路豁免移除对应项

## Comments
