# 01 — 发货抽屉 Tab 拆分：发货信息 / 装箱清单

**What to build:** 销售发货抽屉（`web/app/routes/_app/scm/sales-deliveries/-delivery-drawer.tsx`）的 `extraContent` 从一条纵向长表单改为两 tab——**「发货信息」**（默认）：头字段区域（由 SynieRecordDrawer 渲染，不在 extraContent 内，保持原位）之后的全部内容，即发货条目表格＋借贷科目（`DeliveryAccountFooter`，保持现有相对位置与校验，不单独成 tab）；**「装箱清单」**：装箱行表格（`salDeliveryPackLines` 的 SynieEditableTable）独占迁入，tab 标签带行数徽标（如 `装箱清单 (3)`，0 行时不显示数字或显示空态，以实现时 HeroUI Tabs 惯例为准）。查看/编辑/新建三模式同构；tab 切换不得丢失任何未保存的表格草稿状态（两表 state 本就在 Provider 层，纯展示移动）；`ItemsResetGuard`／`resetItems`（头变清空条目＋装箱行）、`CompanyDefaultSync`、`DeliveryAccountDefaultSync` 等无 UI 副作用组件位置照常。装箱表格的物料候选与 `canCreate` 条件**本票不动**（见票 02）。

**Blocked by:** 无 — 可立即开工

**Status:** resolved

- [x] 抽屉内容切两 tab：发货信息（条目＋借贷科目，默认）/ 装箱清单（装箱表格独占）
- [x] 装箱清单 tab 标签带行数徽标
- [x] 查看/编辑/新建三模式同构；tab 切换不丢未保存草稿
- [x] resetItems 联动、两个 Sync 组件、审核整单弹窗等既有行为不变（`deliveryAuditConfig` 不受影响）
- [x] 手工验证(Playwright:新建抽屉两 tab 渲染、徽标 (1) 随行数出现)：新建/编辑草稿/查看已审核三种路径下两 tab 内容与只读态正确
