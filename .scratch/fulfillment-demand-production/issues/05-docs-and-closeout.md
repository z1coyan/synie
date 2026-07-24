# 05 — 产品文档 + 权限收口 +（可选）演示链样例

**What to build:** 主链（需求 → 可选销售来源 → 工单 → 生产入库）交付后：补齐产品说明书与索引；检查并补全 authz 矩阵世界/权限标签等漏网；可选在初始化示例数据或 `mix synie.demo` 中增加最短生产链样例（需求自制 + 工单 + 一次入库），不阻塞无 demo 的文档收口。

**Blocked by:** 02 — 销售来源勾选 + 占用硬校验；03 — 生产工单；04 — 生产入库 + 超入设置 + 库存与完工回写

**Status:** resolved

**Parent:** [.scratch/fulfillment-demand-production/spec.md](../spec.md)

- [ ] 新增产品文档：履约需求、生产工单、生产入库（只写已实现行为）；`docs/产品文档/README.md` 索引更新
- [ ] `生产BOM.md` 边界与相关文档链接与实现一致
- [ ] authz 矩阵 / 权限中文标签 / gridMeta 无漏（CI 权限覆盖绿）
- [ ] （可选）演示数据含一条可走通的生产链；缺省不视为本票失败
- [ ] CONTEXT/ADR 仅在实现与定案偏差时修订，无偏差则不动

## Answer

已在 `4c58858` 落地后端主链与基础前端；详见 commit。
