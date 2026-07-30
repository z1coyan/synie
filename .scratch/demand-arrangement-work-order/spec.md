# Spec: 履约安排混排 + 生产工单数量/BOM/图纸

**Status:** ready-for-agent  
**Feature slug:** `demand-arrangement-work-order`  
**Depends on:** 履约需求与生产执行（已交付）、需求-采购串联（已交付）、BOM/工序主数据（已交付）、委外采购（已交付）  
**ADR:** [docs/adr/2026-07-30-demand-arrangement-and-work-order-bom.md](../../docs/adr/2026-07-30-demand-arrangement-and-work-order-bom.md)  
**Domain terms:** 履约需求行、安排、已安排数量、已完成数量、需求超安排比例、生产工单、BOM（草稿/启用/停用）、图纸（见 `CONTEXT.md`）  
**产品说明（定案已落盘）:** `docs/产品文档/履约需求.md`、`生产工单.md`、`生产BOM.md`、`采购订单.md`；`CONTEXT.md` 已同步  
**Tickets:** [.scratch/demand-arrangement-work-order/issues/](./issues/)  
**Seams (confirmed):** 制造集成测试 + 采购勾选/审核测试 + BOM 主数据测试；可选共享「剩余可安排/完成判定」纯函数

---

## Problem Statement

计划员面对同一条履约需求行，经常需要**混用出口**（部分自制、部分外购、部分现货结清、部分关闭放弃），但现状强制行级「履约方式」四选一，自制还卡「一需求行一张未作废工单、数量锁死需求行」——拆批只能拆行，车间无法分批开工。生产工单也缺配方与图纸：车间不知道按哪张 BOM 做、现场看图还得回物料主数据；没有现成 BOM 时又要跳出工单去建主数据再回来。采购侧「已下单」与生产侧 1:1 工单不对称，需求行「都是怎么安排的」看不见。

## Solution

1. **砍掉行级履约方式**，以**安排**子表为唯一出口事实：生产 / 采购 / 委外由执行单据倒写，库存 / 关闭手工维护。  
2. 需求行双投影 **已安排数量** + **已完成数量**；行完成 = 排满且履行完；新增 **需求超安排比例**（覆盖旧超下单语义）。  
3. 生产工单 **可多张、数量可填**；可选 **启用中 BOM** 并快照配料/路线/副产品；创建时 **复制物料图纸**；表单内嵌完整 **BOM 创建**。  
4. BOM 主数据改为 **草稿 → 启用 ⇄ 停用**（仅草稿可删、仅启用可选入新单）。

## User Stories

1. As a 计划员, I want 需求行上不再选履约方式, so that 同一行可以混用多种出口  
2. As a 计划员, I want 在需求行看到安排子表（类型/数量/下游单据）, so that 知道都是怎么消化的  
3. As a 计划员, I want 手工加「库存」安排并指定数量, so that 现货满足有明确登记且不扣库存  
4. As a 计划员, I want 手工加「关闭」安排并指定数量, so that 明确放弃的量离开待办  
5. As a 计划员, I want 关闭数量硬卡不超过剩余可安排, so that 不会关掉不存在的量  
6. As a 计划员, I want 看到已安排数量与已完成数量两列, so that 区分「排了没收」与「收了未排满」  
7. As a 计划员, I want 行在排满且已完成≥需求时自动完成, so that 不用手工点完成  
8. As a 计划员, I want 取消行上「点完成」按钮, so that 完成语义只走安排与入库  
9. As a 计划员, I want 需求单关闭后不能再新安排, so that 待办收敛  
10. As a 计划员, I want 有未作废工单/已审核采购条目/手工安排时不能作废需求单, so that 不断链  
11. As a 车间主任, I want 从已确认未关闭需求行开多张工单, so that 分批投产  
12. As a 车间主任, I want 工单数量默认为剩余可安排且可手改, so that 不必开满整行  
13. As a 车间主任, I want 创建工单即占已安排, so that 别人不会超排  
14. As a 车间主任, I want 尚无已审核生产入库时改工单数量, so that 纠错不用整单作废  
15. As a 车间主任, I want 尚无已审核生产入库时作废工单并释放已安排, so that 可重开  
16. As a 车间主任, I want 工单上可选本物料启用中 BOM, so that 明确按哪张配方做  
17. As a 车间主任, I want 选 BOM 后看到配料/工艺路线/副产品快照, so that 现场有执行口径  
18. As a 车间主任, I want 无入库前换 BOM 或手改快照, so that 本单配方可微调  
19. As a 车间主任, I want 有已审核入库后 BOM 快照锁死, so that 半截工单配方不漂  
20. As a 车间主任, I want 工单可空 BOM, so that 简单件不强制配方  
21. As a 车间主任, I want 在工单内完整创建 BOM 并立即选入, so that 不必跳出到 BOM 菜单  
22. As a 车间主任, I want 创建工单时自动带上物料图纸, so that 现场可看图  
23. As a 车间主任, I want 物料无图纸时仍可开工单, so that 不挡生产  
24. As a 采购员, I want 从需求池勾选时不再按外购/委外行过滤, so that 混排行也能下单  
25. As a 采购员, I want 数量默认=剩余可安排, so that 与计划占坑一致  
26. As a 采购员, I want 草稿订单仍不占已安排、审核才占, so that 草稿是私有工作区  
27. As a 采购员, I want 审核时过需求超安排比例, so that 起订量可受控超排  
28. As a 采购员, I want 审核后需求行出现采购/委外安排, so that 计划侧子表可见  
29. As a 采购员, I want 作废订单释放对应已安排, so that 可再安排  
30. As a 仓管, I want 生产入库审核累加工单已入与需求行已完成, so that 双投影收敛  
31. As a 仓管, I want 入库作废回滚已完成分量, so that 纠错一致  
32. As a 工艺员, I want 新建 BOM 为草稿并可启用, so that 未就绪配方不进选单  
33. As a 工艺员, I want 启用与停用可互转, so that 配方可暂时退出主路径  
34. As a 工艺员, I want 仅草稿可删除, so that 启用过的配方有留痕  
35. As a 工艺员, I want 工单/委外选择器只列启用中 BOM, so that 不会选到停用配方  
36. As a 工艺员, I want 启用后仍可改 BOM 主数据, so that 维护不卡；已快照工单不追溯  
37. As a 管理员, I want 配置需求超安排比例（默认 0）, so that 全行安排共用一把尺子  
38. As a 管理员, I want 旧「需求超下单比例」语义被超安排比例覆盖, so that 设置不两套打架  
39. As a 系统, I want 工单创建/采购审核/库存关闭保存统一校验超安排, so that 占量不破  
40. As a 系统, I want 关闭安排不吃超安排容差, so that 放弃量不会被容差吹大  
41. As a 计划员, I want 列表按剩余可安排/已完成筛选待办, so that 替代旧履约方式筛选  
42. As a 开发, I want 集成测试覆盖混排与回滚, so that 投影不漂  
43. As a 审计人员, I want 安排与工单 BOM 变更进审计, so that 可追溯  

## Implementation Decisions

### 测试缝（seams）

优先复用并扩展现有最高层缝，少开新缝：

1. **主缝：制造域集成测试**（`manufacturing.integration.test.ts` 及 demand/work-order/output 服务级 postgres 测试）  
   - 覆盖：需求行无履约方式后的建单确认；库存/关闭安排；多工单数量与超安排；工单 BOM 快照与图纸；生产入库累加已完成；BOM 启停选单。  
2. **采购勾选与审核缝**（采购订单既有「从需求勾选 / 审核占量」集成测试）  
   - 去掉履约方式匹配；改为剩余可安排 + 超安排比例；审核倒写安排。  
3. **BOM 主数据缝**（`master-service` / manufacturing meta 测试）  
   - 草稿删除、启停互转、非启用不可被工单/委外选择。  

**不**为 UI 单独开 E2E 作为验收主缝；前端跟随后端契约与既有 drawer 模式。若需新缝，只允许在「需求行安排投影」上抽一个**纯函数/领域助手**（已安排/已完成合成、剩余可安排、完成判定），供 demand / work-order / purchase / output 共用，避免四处复制公式。

### 数据模型

- 新增 `mfg_demand_arrangement`（或等价名）：`demand_item_id`、`type`（make|purchase|outsource|stock|close）、`qty`/`base_qty`、下游引用（`work_order_id` / `purchase_order_item_id` 可空）、时间戳；倒写类随下游作废删除或标记。  
- `mfg_demand_item`：废弃写入 `fulfillment_method`（迁移：可空后删列，或保留只读兼容一期后删）；新增 `arranged_qty`、`completed_qty` 投影列（默认单位）；保留 `ordered_qty`/`received_qty` 作采购细分。  
- 行 `status`：仍 pending/completed（或 arranged 派生展示）；完成条件改为双投影。  
- `mfg_work_order`：去掉「一活跃需求行唯一」唯一索引；允许同 `demand_item_id` 多张非 voided；`qty` 可填；可空 `bom_id`（来源留痕）；快照子表 `mfg_work_order_component` / `_route` / `_byproduct`（结构对齐 BOM 子表，数量语义为每 1 母单位净用量等，同 BOM）；图纸挂接宿主类型扩工单。  
- `mfg_bom`：加 `status`（draft|active|inactive）；删除接口仅 draft。  
- `sal_setting`：`demand_overorder_ratio` **语义升级为需求超安排比例**（列可 rename 为 `demand_over_arrange_ratio` 或保留列名改文案与校验调用点——实现任选，对外产品名统一「需求超安排比例」）。

### 领域规则（硬）

- 已安排 = Σ 未作废工单 base + Σ 已审核未作废挂行采购/委外条目 base + Σ 库存安排 + Σ 关闭安排。  
- 已完成 = Σ 生产入库（经工单挂行）+ Σ 采购/委外入库回写 + Σ 库存 + Σ 关闭。  
- 超安排：`arranged ≤ demand_base × (1 + ratio)`；关闭额外 `close_qty ≤ remaining`（不吃 ratio）。  
- 工单：需求单 confirmed 未关闭；数量默认 remaining（不含 ratio 超额）；无入库可改量/作废；创建倒写 make 安排。  
- BOM 快照：仅 active 可选；选后复制；有已审核生产入库锁快照。  
- 采购勾选池：去掉 method 过滤；过滤剩余可安排 > 0。  

### 模块边界

- 制造：`demand-service`、`work-order-service`、`output-service`、`master-service`（BOM 状态）、meta/wire/routes、前端 `mfg/demands*`、`work-orders`、`boms`。  
- 采购：订单勾选池、审核占量、设置文案。  
- 附件：工单 drawing 挂接复制（对齐发货/订单条目）。  

### API / UI

- 需求行：安排子表只读+库存/关闭 CRUD；去掉履约方式与点完成。  
- 工单：数量字段、BOM 选择器、快照展示/编辑、内嵌 BOM 创建、图纸只读展示。  
- BOM：状态操作与选择器过滤。  
- 设置：采购 Tab 标签改为超安排比例。  

## Testing Decisions

- 只测外部行为：投影数字、可否建单/审核/作废、完成翻转、选择器可见性；不测内部是否物化安排行 vs 视图表（实现可选，验收以投影与子表展示为准）。  
- 优先扩展既有 manufacturing / purchase 集成测试夹具与权限矩阵世界（若权限动作不变可只 smoke）。  
- 关键矩阵：  
  - 混排 40 工单 + 30 采购 + 30 关闭 → 排满；入库未齐则未完成。  
  - 双工单数量合计超剩余 → 第二张拒。  
  - 草稿采购不占；审核占；作废释放。  
  - 工单有入库后改量/换 BOM 拒；作废拒。  
  - 停用 BOM 不可新选；草稿可删、active 不可删。  

## Out of Scope

- 先写安排再派生执行的「计划占坑」模型  
- 无来源需求行的独立工单  
- 按工单 BOM 快照实扣料、工序报工、WIP  
- 打印模板图片类图纸渲染（系统现状不支持图片占位符）  
- 有限产能/APS  
- BOM 版本树 / 变更单  

## Further Notes

- 定案访谈见会话 grill-with-docs；领域词条与 ADR 已先于本 spec 落盘。  
- 存量数据：行上 `fulfillment_method` 迁移策略——历史行可按 method 不回填安排（已有工单/订单会倒写重建投影），或一次性脚本按下游重建安排；实现票内写清回填策略。  
- 手改工单快照不回写 BOM；工单内建 BOM 进全局主数据（默认草稿或启用由实现选「创建即启用」更贴「立即选入」——**推荐创建即启用**，与「保存并选入」一致）。  
