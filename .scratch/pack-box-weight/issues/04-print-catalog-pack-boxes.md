# 04 — 打印字段目录：`pack_lines` 携箱字段 + `pack_boxes` 循环区

**What to build:** 打印字段目录随箱实体升级：装箱行仍以 `pack_lines` 平铺循环区挂在发货单下，行内箱级字段经装箱行 belongs_to 箱一层展开（如 `${pack_lines.box_no}`、`${pack_lines.box_gross_weight}`、`${pack_lines.box_net_weight}`，遵循「belongs_to 展开一层、不再下钻」的既有占位符规则）；新增 `pack_boxes` 独立 has_many 循环区（箱号/箱净重/箱毛重/重量单位名），含循环区零行整行删除语义。模板上传校验识别新字段路径（未知字段照常拒绝并点名）。打印引擎零改动，不引入嵌套循环。渲染行为测试走 `renderer.test.ts` 先例（既有 `pack_lines` 循环区用例平移）。

**Blocked by:** 03 — 箱级重量：箱毛重、箱净重聚合与重量单位（循环区要暴露的箱级字段须先存在）。

**Status:** ready-for-agent

- [ ] `${pack_lines.*}` 循环区可渲染箱级字段（belongs_to 箱一层展开）
- [ ] `${pack_boxes.*}` 循环区按箱数据行数复制模板行，含 `${pack_boxes._seq}`
- [ ] `pack_boxes` 零行时其模板行整行删除；`pack_lines` 既有行为不回归
- [ ] 模板上传校验接受新字段路径、拒绝未知路径并点名
- [ ] 字段清单（模板管理页）自动包含新路径（自 meta.Registry 派生）
- [ ] 渲染引擎单测覆盖上述行为（renderer.test.ts 先例）
