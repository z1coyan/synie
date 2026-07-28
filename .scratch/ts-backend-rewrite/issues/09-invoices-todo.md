# 09 发票 + 待办

Status: ready-for-human
Blocked by: 08

## Comments

- 2026-07-28 子代理：实现增值税发票完整生命周期（CRUD/审核过账/作废/红冲/OCR 入口）与待办消费 API（query/unread-count/read/dismiss）；对账 confirm 生产者与 closeFromInvoice/reopenFromInvoice 接缝复用已有 trading/reconciliation。`bunx tsc --noEmit` 绿；`SYNIE_TEST_DATABASE_URL=… bun test` 207 pass。遗留：报销单/银行/票据（工单 12）未做，`verify-finance-operations-rest` 全量仍阻塞于非发票段；OCR 需 acc_setting 阿里云凭证（未配置时返回可读 validation）。
- 2026-07-28 验收补强：audit 默认 limit=50 + 公司隔离 404；todo unread 接受 create|read；新增 `verify-invoices-todo-rest.ts`。验收：`verify-invoices-todo-rest` → ok meta=3 permissionFirst=10 wire=46 states=21 todos=10；`verify-system-ops-rest` → ok（含 todoBehavior=7 todoState=9）；typecheck 绿；bun test 207 pass。剩余：`verify-finance-operations-rest` 全量仍依赖工单 12（银行/报销/票据）。
- 2026-07-28 主工作区集成：cherry-pick `e47f6c0`（发票生命周期+待办 API）/ `53e1e19`（audit/todo 权限对齐 + verify-invoices-todo-rest）；app/index/Meta/helpers 装配已在候选提交内完整挂载（`/finance/vat-invoices`、`/todos`、registerFinanceResources）。验证：`bunx tsc --noEmit` 绿；`SYNIE_TEST_DATABASE_URL=… bun test` 209 pass；`verify-invoices-todo-rest` against :18083 → `ok meta=3 permissionFirst=10 wire=46 states=21 todos=10`；`verify-system-ops-rest` → `ok … todoBehavior=7 todoState=9`。遗留：`verify-finance-operations-rest` 全量仍依赖工单 12（银行/报销/票据）；OCR live 需 acc_setting 阿里云凭证。

## 范围

1. **发票**（开入/开出；常规发票关联对账单：审核校验一对一+过账三行+冲回组回未开票往来；作废/红冲自动解除关联退回确认态；对向发票互链与一键生成对方草稿；费用报销发票：方向开入/对手限员工/报销类型带科目/审核挂账其他应付款）
2. **待办设施**（开票待办/收票待办：确认产生、结单关闭、撤回消失、退回复活；可见性=可见该公司+持发票创建权限；已读与个人忽略含复位基准；列表/计数端点）
3. 发票 OCR 识别入口（阿里云凭证读 acc_setting；识别结果预填草稿）

## 行为参考

`server-go/internal/domain/finance/documents/`（invoice）；`.scratch/todo-facility/spec.md`；CONTEXT「开票待办」「收票待办」「费用报销发票」词条。

## 验收

- `verify-finance-operations-rest.ts` 发票段全绿
- 待办出现/关闭/复活/忽略复位测试；发票↔对账联动（结单/退回）测试

## 非目标

报销单（工单 12）；OCR 新供应商接入（维持阿里云现状）。
