# Presentation Extension locality

Status: ready-for-agent

## 目标

把 Drawer、审核与文档预览 implementation 放回对应资源业务 module；全局 registry 只承担薄装配。

## 验收

- Resource Catalog 只保留静态资源事实。
- Presentation Extension interface 保持小而稳定。
- 未知资源继续 fail-closed。
- 行为测试覆盖已迁移扩展，不依赖源码正则。

## Comments

- 2026-07-31：分派给 subagent `presentation_locality`。本项显式重访 resource-catalog issue 12 保留集中配置的既有取舍。
- 2026-07-31：首个完整业务域切片选择其他库存单（库存单、调拨、盘点）；该域没有审核配置，不为统一外形虚构 audit interface。
- 2026-07-31：其他库存单切片 4 个 interface 行为测试、前端 check/typecheck 通过；继续按业务域迁移剩余 18 项，使全局 registry 最终只承担装配。
- 2026-07-31：21 项已全部迁出；Drawer registry 收缩为 49 行、preview registry 14 行，均无内嵌资源配置。新增 interface tests 8/8（235 expects），check/typecheck 通过。
- 2026-07-31 独立审查：DocumentPreviewLineTable 仍携带具体 client，形成第二份 resource→Adapter 关联，且独立 `documentPreviewLines` key 不受 binding 失效命中。已分派修复为 resource + binding reader/cache；委外入库两段业务 loader 保留但不直接绑定生产 client。
- 2026-07-31：Preview 配置已删除具体 client；标准子表通过 resource binding 同时取得 Reader 与 cache key，委外入库两段 loader 只注入最小 Reader resolver。Presentation 目录的生产 client import/config 已清零，memory Reader 替换与 binding.invalidateGrid 前缀命中均有行为测试。
- 2026-07-31：终验确认 21 项 Drawer 与 8 项 preview 均由业务模块拥有，全局 registry 保持薄装配并对未知资源 fail-closed；生产 Presentation 目录不再保存 transport/client 身份。
