# 标准动作内核（platform/standard）

日期：2026-08-06

## 决定

- 资源动作收敛至封闭词表：创建/更新/删除/审核/打印 × 单条/批量（+作废）。本期落地 CRUD+批量；审核/作废（统一单据状态机 draft→approved→voided，效果挂 afterApprove/afterVoid 钩子）下期进内核。
- 平坦主数据资源一律用 `platform/standard` 派生服务与路由：meta 声明（字段 required/maxLength/nullable/createOnly/enum）派生 wire schema、行映射、审计快照、DTO；授权/盖章/审计/事务由平台既有原语编排。模块侧只写领域不变量钩子（validate/beforeWrite/afterWrite/beforeDelete）与约束文案。
- 钩子纪律：只做领域不变量与行内充实；跨资源流程（过账/占量等）不进钩子，留在手写服务与引擎。
- 逃生舱按动作弹射：派生与手写服务对路由不可区分；任何动作复杂化即单独换回手写，不做 all-or-nothing。
- 标准派生资源必须声明完整词表（装配期断言）；路由全链式注册以保 ApiType 类型链。
- 合同测试写一次全站摊销：审计三型、无差异不落库、批量全成全败、越权 fail-closed，新资源迁入即免费继承（`standard-contract.postgres.test.ts` 加一行描述符）。

## 现状

试点：计量单位、币种（全局域）、银行账户（公司域）。单资源模块侧约 300 行 → 50-60 行。

## 待办

- 树形资源（分类/部门/科目/公司）：投影派生（父 join/has_children）+ 树锁钩子，内核 v2。（部分已落地，残余见标准迁移决策日志弹射项。）
- ~~审核/作废 + 统一单据状态机，单据资源迁入。~~ **已由聚合单据内核承接**：workflow transitions + 聚合草稿见 [`2026-08-07-aggregate-document-kernel.md`](2026-08-07-aggregate-document-kernel.md)。
- 类型级 wire 派生（const meta → 精确输入类型），恢复 client 端字段级类型精度。
