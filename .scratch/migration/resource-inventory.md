# 迁移资源清单

权威盘点时间：2026-07-25。来源是 `SynieCore` Domain 的 `resources do` 注册表、
`SynieWeb.GridMeta` 白名单和各 Resource 实现。

R3 文档记录“122 Ash Resource”，但当前代码的权威 Domain 实际注册 **100** 个资源，
Grid 白名单为 **90**。`rg -l 'use Ash.Resource'` 会把包含
`Ash.Resource.Validation/Change` 的文件计入，不能作为 Resource 数量。迁移以这里的
100 个运行时注册资源为准；若后续发现未注册但仍有产品写表面的模块，单独补入清单并写明
来源，不把 Validation/Change 当资源迁移。

标记说明：

- `Grid:key`：当前 GridMeta 白名单。
- `Print`：当前资源自身拥有非空权限动作，进入打印资源目录。
- `GL` / `Stock`：参考实现直接调用对应事实引擎。
- `Import` / `OCR`：有导入或 OCR 表面。
- 批次遵循 R3：1 内核证明、2 平台/主数据、3 引擎/库存凭证、4 销采链、5 扩展域。

| 批次 | Resource module | 表/视图 | 权限前缀 | 表面 | 标准 CRUD 外动作 | 状态 |
|---:|---|---|---|---|---|---|
| 2 | `SynieCore.Accounts.User` | `sys_user` | `sys.user` | Grid:sysUsers / Print | reset_password, by_username, set_super_admin | 已完成 |
| 2 | `SynieCore.Authz.Role` | `sys_role` | `sys.role` | Grid:sysRoles / Print | — | 已完成 |
| 2 | `SynieCore.Authz.UserRole` | `sys_user_role` | `sys.user` | — | — | 已完成 |
| 2 | `SynieCore.Authz.RolePermission` | `sys_role_permission` | `sys.role_permission` | Print | sync | 已完成 |
| 2 | `SynieCore.Authz.UserCompany` | `sys_user_company` | `sys.user` | — | — | 已完成 |
| 2 | `SynieCore.Base.Company` | `bas_company` | `base.company` | Grid:basCompanies / Print | — | 已完成 |
| 2 | `SynieCore.Base.Unit` | `bas_unit` | `base.unit` | Grid:basUnits / Print | — | 已完成 |
| 1 | `SynieCore.Base.Currency` | `bas_currency` | `base.currency` | Grid:basCurrencies / Print | — | 已完成 |
| 2 | `SynieCore.Base.MarketInstrument` | `bas_market_instrument` | `base.market_instrument` | Grid:basMarketInstruments / Print | — | 已完成 |
| 2 | `SynieCore.Base.MarketPricePoint` | `bas_market_price_point` | `base.market_price` | Grid:basMarketPricePoints / Print | void, refresh, chart_instruments, price_series | 已完成 |
| 2 | `SynieCore.Base.Account` | `bas_account` | `base.account` | Grid:basAccounts / Print | init_from_template | 已完成 |
| 2 | `SynieCore.Sales.Customer` | `sal_customers` | `sales.customer` | Grid:salCustomers / Print | — | 已完成 |
| 4 | `SynieCore.Sales.Order` | `sal_order` | `sales.order` | Grid:salOrders / Print | audit, close, void | 已完成 |
| 4 | `SynieCore.Sales.OrderItem` | `sal_order_item` | `sales.order` | Grid:salOrderItems | recalc_base, adjust_shipped_qty | 已完成 |
| 4 | `SynieCore.Sales.Delivery` | `sal_delivery` | `sales.delivery` | Grid:salDeliveries / Print / GL / Stock | audit, void | 已完成 |
| 4 | `SynieCore.Sales.DeliveryItem` | `sal_delivery_item` | `sales.delivery` | Grid:salDeliveryItems | adjust_reconciled_qty | 已完成 |
| 4 | `SynieCore.Sales.Reconciliation` | `sal_reconciliation` | `sales.reconciliation` | Grid:salReconciliations / Print / GL | confirm, unconfirm, audit, void, close_from_invoice, reopen_from_invoice | 已完成 |
| 4 | `SynieCore.Sales.ReconciliationItem` | `sal_reconciliation_item` | `sales.reconciliation` | Grid:salReconciliationItems | — | 已完成 |
| 4 | `SynieCore.Sales.Quotation` | `sal_quotation` | `sales.quotation` | Grid:salQuotations / Print | audit, void | 已完成 |
| 4 | `SynieCore.Sales.QuotationItem` | `sal_quotation_item` | `sales.quotation` | Grid:salQuotationItems | — | 已完成 |
| 4 | `SynieCore.Sales.QuotationTier` | `sal_quotation_tier` | `sales.quotation` | Grid:salQuotationTiers | purge | 已完成 |
| 4 | `SynieCore.Sales.Setting` | `sal_setting` | `sales.setting` | Print | — | 已完成 |
| 4 | `SynieCore.Sales.CompanyAccountDefault` | `sal_company_account_default` | `sales.setting` | Grid:salCompanyAccountDefaults | — | 已完成 |
| 2 | `SynieCore.Purchase.Supplier` | `pur_supplier` | `purchase.supplier` | Grid:purSuppliers / Print | — | 已完成 |
| 4 | `SynieCore.Purchase.Quotation` | `pur_quotation` | `purchase.quotation` | Grid:purQuotations / Print | audit, void | 已完成 |
| 4 | `SynieCore.Purchase.QuotationItem` | `pur_quotation_item` | `purchase.quotation` | Grid:purQuotationItems | — | 已完成 |
| 4 | `SynieCore.Purchase.QuotationTier` | `pur_quotation_tier` | `purchase.quotation` | Grid:purQuotationTiers | purge | 已完成 |
| 4 | `SynieCore.Purchase.Order` | `pur_order` | `purchase.order` | Grid:purOrders / Print | audit, close, void | 已完成 |
| 4 | `SynieCore.Purchase.OrderItem` | `pur_order_item` | `purchase.order` | Grid:purOrderItems | recalc_base, adjust_received_qty, demand_line_pool | 已完成 |
| 4 | `SynieCore.Purchase.OrderItemMaterial` | `pur_order_item_material` | `purchase.order` | Grid:purOrderItemMaterials | adjust_issued_qty | 已完成 |
| 4 | `SynieCore.Purchase.OrderItemByproduct` | `pur_order_item_byproduct` | `purchase.order` | Grid:purOrderItemByproducts | — | 已完成 |
| 4 | `SynieCore.Purchase.Receipt` | `pur_receipt` | `purchase.receipt` | Grid:purReceipts / Print / GL / Stock | audit, void | 已完成 |
| 4 | `SynieCore.Purchase.ReceiptItem` | `pur_receipt_item` | `purchase.receipt` | Grid:purReceiptItems | adjust_reconciled_qty | 已完成 |
| 4 | `SynieCore.Purchase.OutsourcedIssue` | `pur_outsourced_issue` | `purchase.outsourced_issue` | Grid:purOutsourcedIssues / Print / Stock | audit, void | 已完成 |
| 4 | `SynieCore.Purchase.OutsourcedIssueItem` | `pur_outsourced_issue_item` | `purchase.outsourced_issue` | Grid:purOutsourcedIssueItems | — | 已完成 |
| 4 | `SynieCore.Purchase.OutsourcedReceipt` | `pur_outsourced_receipt` | `purchase.outsourced_receipt` | Grid:purOutsourcedReceipts / Print / GL / Stock | audit, void | 已完成 |
| 4 | `SynieCore.Purchase.OutsourcedReceiptItem` | `pur_outsourced_receipt_item` | `purchase.outsourced_receipt` | Grid:purOutsourcedReceiptItems | adjust_reconciled_qty | 已完成 |
| 4 | `SynieCore.Purchase.OutsourcedReceiptItemMaterial` | `pur_outsourced_receipt_item_material` | `purchase.outsourced_receipt` | Grid:purOutsourcedReceiptItemMaterials | — | 已完成 |
| 4 | `SynieCore.Purchase.OutsourcedReceiptItemByproduct` | `pur_outsourced_receipt_item_byproduct` | `purchase.outsourced_receipt` | Grid:purOutsourcedReceiptItemByproducts | — | 已完成 |
| 4 | `SynieCore.Purchase.Reconciliation` | `pur_reconciliation` | `purchase.reconciliation` | Grid:purReconciliations / Print / GL | confirm, unconfirm, audit, void, close_from_invoice, reopen_from_invoice | 已完成 |
| 4 | `SynieCore.Purchase.ReconciliationItem` | `pur_reconciliation_item` | `purchase.reconciliation` | Grid:purReconciliationItems | — | 已完成 |
| 5 | `SynieCore.Scm.OrderFlowItem` | `scm_order_flow_item` | `scm.order_flow` | Grid:scmOrderFlowItems | — | 已完成 |
| 2 | `SynieCore.Hr.Employee` | `hr_employees` | `hr.employee` | Grid:hrEmployees / Print | — | 已完成 |
| 5 | `SynieCore.Mfg.Operation` | `mfg_operation` | `mfg.operation` | Grid:mfgOperations / Print | — | 已完成 |
| 5 | `SynieCore.Mfg.ProcessTemplate` | `mfg_process_template` | `mfg.route_template` | Grid:mfgProcessTemplates / Print | — | 已完成 |
| 5 | `SynieCore.Mfg.ProcessTemplateItem` | `mfg_process_template_item` | `mfg.route_template` | Grid:mfgProcessTemplateItems | — | 已完成 |
| 5 | `SynieCore.Mfg.Bom` | `mfg_bom` | `mfg.bom` | Grid:mfgBoms / Print | apply_route_template | 已完成 |
| 5 | `SynieCore.Mfg.BomComponent` | `mfg_bom_component` | `mfg.bom` | Grid:mfgBomComponents | — | 已完成 |
| 5 | `SynieCore.Mfg.BomRoute` | `mfg_bom_route` | `mfg.bom` | Grid:mfgBomRoutes | — | 已完成 |
| 5 | `SynieCore.Mfg.BomByproduct` | `mfg_bom_byproduct` | `mfg.bom` | Grid:mfgBomByproducts | — | 已完成 |
| 5 | `SynieCore.Mfg.Demand` | `mfg_demand` | `mfg.demand` | Grid:mfgDemands / Print | confirm, close, void | 已完成 |
| 5 | `SynieCore.Mfg.DemandItem` | `mfg_demand_item` | `mfg.demand` | Grid:mfgDemandItems | complete, set_status, adjust_ordered_qty, adjust_received_qty, change_fulfillment, sales_item_occupancy | 已完成 |
| 5 | `SynieCore.Mfg.WorkOrder` | `mfg_work_order` | `mfg.work_order` | Grid:mfgWorkOrders / Print | void, adjust_received | 已完成 |
| 5 | `SynieCore.Mfg.Output` | `mfg_output` | `mfg.output` | Grid:mfgOutputs / Print / Stock | audit, void | 已完成 |
| 5 | `SynieCore.Mfg.OutputItem` | `mfg_output_item` | `mfg.output` | Grid:mfgOutputItems | — | 已完成 |
| 5 | `SynieCore.Mfg.Setting` | `mfg_setting` | `mfg.setting` | Print | — | 已完成 |
| 2 | `SynieCore.Inv.MaterialCategory` | `inv_material_category` | `inv.material_category` | Grid:invMaterialCategories / Print | — | 已完成 |
| 2 | `SynieCore.Inv.Material` | `inv_material` | `inv.material` | Grid:invMaterials / Print | — | 已完成 |
| 2 | `SynieCore.Inv.MaterialUnit` | `inv_material_unit` | `inv.material` | Grid:invMaterialUnits | — | 已完成 |
| 2 | `SynieCore.Inv.Warehouse` | `inv_warehouse` | `inv.warehouse` | Grid:invWarehouses / Print | outsourced, seed_defaults | 已完成 |
| 3 | `SynieCore.Inv.StockEntry` | `inv_stock_entry` | `inv.stock_entry` | Grid:invStockEntries / Print / Stock | mark_cancelled, stock_balance | 已完成 |
| 3 | `SynieCore.Inv.StockDoc` | `inv_stock_doc` | `inv.stock_doc` | Grid:invStockDocs / Print / Stock | audit, void | 已完成 |
| 3 | `SynieCore.Inv.StockDocItem` | `inv_stock_doc_item` | `inv.stock_doc` | Grid:invStockDocItems | — | 已完成 |
| 3 | `SynieCore.Inv.StockTransfer` | `inv_stock_transfer` | `inv.stock_transfer` | Grid:invStockTransfers / Print / Stock | ship, receive | 已完成 |
| 3 | `SynieCore.Inv.StockTransferItem` | `inv_stock_transfer_item` | `inv.stock_transfer` | Grid:invStockTransferItems | write_received | 已完成 |
| 3 | `SynieCore.Inv.StockCount` | `inv_stock_count` | `inv.stock_count` | Grid:invStockCounts / Print / Stock | refresh, approve, cancel | 已完成 |
| 3 | `SynieCore.Inv.StockCountItem` | `inv_stock_count_item` | `inv.stock_count` | Grid:invStockCountItems | sync_book_quantity | 已完成 |
| 5 | `SynieCore.Hr.AttendancePunch` | `hr_attendance_punch` | `hr.attendance_punch` | Grid:hrAttendancePunches / Print / Import | — | 已完成 |
| 5 | `SynieCore.Hr.AttendanceImport` | `hr_attendance_import` | `hr.attendance_punch` | Grid:hrAttendanceImports / Import | import | 已完成 |
| 5 | `SynieCore.Hr.AttendanceDay` | `hr_attendance_day` | `hr.attendance_day` | Grid:hrAttendanceDays / Print | recalc, month_summary | 已完成 |
| 5 | `SynieCore.Hr.AttendanceCorrection` | `hr_attendance_correction` | `hr.attendance_correction` | Grid:hrAttendanceCorrections / Print | — | 已完成 |
| 5 | `SynieCore.Hr.Payroll` | `hr_payroll` | `hr.payroll` | Grid:hrPayrolls / Print | refresh, mark_paid, mark_pending, generate, month_stats | 已完成 |
| 5 | `SynieCore.Hr.PayrollPayment` | `hr_payroll_payment` | `hr.payroll_payment` | Grid:hrPayrollPayments / Print | pay_remaining | 已完成 |
| 5 | `SynieCore.Hr.EmployeeLoan` | `hr_employee_loan` | `hr.employee_loan` | Grid:hrEmployeeLoans / Print | auto_repay, auto_destroy, balances | 已完成 |
| 3 | `SynieCore.Acc.GlEntry` | `acc_gl_entry` | `acc.gl_entry` | Grid:accGlEntries / Print / GL | mark_cancelled, mark_reversed, ar_ap_report | 已完成 |
| 3 | `SynieCore.Acc.GlJournal` | `acc_gl_journal` | `acc.gl_journal` | Grid:accGlJournals / Print / GL | audit, cancel | 已完成 |
| 3 | `SynieCore.Acc.GlJournalLine` | `acc_gl_journal_line` | `acc.gl_journal` | Grid:accGlJournalLines | — | 已完成 |
| 5 | `SynieCore.Acc.BankAccount` | `acc_bank_account` | `acc.bank_account` | Grid:accBankAccounts / Print | — | 已完成 |
| 5 | `SynieCore.Acc.BankTransaction` | `acc_bank_transaction` | `acc.bank_transaction` | Grid:accBankTransactions / Print / Import | refresh_reconcile | 已完成 |
| 5 | `SynieCore.Acc.BankImportTemplate` | `acc_bank_import_template` | `acc.bank_import_template` | Grid:accBankImportTemplates / Print / Import | — | 已完成 |
| 5 | `SynieCore.Acc.BankImport` | `acc_bank_import` | `acc.bank_transaction` | Grid:accBankImports / Import | import | 已完成 |
| 5 | `SynieCore.Acc.BankImportItem` | `acc_bank_import_item` | `acc.bank_transaction` | Grid:accBankImportItems / Import | link_transaction | 已完成 |
| 5 | `SynieCore.Acc.VatInvoice` | `acc_vat_invoice` | `acc.vat_invoice` | Grid:accVatInvoices / Print / GL / OCR | audit, void, reverse, ocr | 已完成 |
| 5 | `SynieCore.Acc.ExpenseReport` | `acc_expense_report` | `acc.expense_report` | Grid:accExpenseReports / Print / GL | audit, void | 已完成 |
| 5 | `SynieCore.Acc.ExpenseReportItem` | `acc_expense_report_item` | `acc.expense_report` | Grid:accExpenseReportItems | — | 已完成 |
| 5 | `SynieCore.Acc.Bill` | `acc_bill` | `acc.bill` | Grid:accBills / Print | register | 已完成 |
| 5 | `SynieCore.Acc.BillTransaction` | `acc_bill_transaction` | `acc.bill_transaction` | Grid:accBillTransactions / Print / GL / OCR | audit, void, ocr | 已完成 |
| 5 | `SynieCore.Acc.BillHolding` | `acc_bill_holding` | `acc.bill_holding` | Grid:accBillHoldings / Print | rebuild | 已完成 |
| 5 | `SynieCore.Acc.BankReconciliation` | `acc_bank_reconciliation` | `acc.bank_transaction` | Grid:accBankReconciliations | quick_create, remaining | 已完成 |
| 5 | `SynieCore.Acc.Setting` | `acc_setting` | `acc.setting` | Print / OCR | ocr_configured | 已完成 |
| 5 | `SynieCore.Audit.Log` | `sys_audit_log` | `sys.audit_log` | Grid:sysAuditLogs / Print | record | 已完成 |
| 5 | `SynieCore.Sys.Setting` | `sys_setting` | `sys.setting` | Print | record_market_fetch | 已完成 |
| 5 | `SynieCore.Sys.Todo` | `sys_todo` | `sys.todo` | — | create_internal, close_internal, mark_read, dismiss, unread_count | 已完成 |
| 5 | `SynieCore.Sys.TodoState` | `sys_todo_state` | `sys.todo_state` | — | create_internal, upsert_internal | 已完成 |
| 2 | `SynieCore.Numbering.Rule` | `sys_numbering_rule` | `sys.numbering_rule` | Grid:sysNumberingRules / Print | — | 已完成 |
| 2 | `SynieCore.Numbering.Counter` | `sys_numbering_counter` | `sys.numbering_rule` | Grid:sysNumberingCounters | — | 已完成 |
| 5 | `SynieCore.Printing.Template` | `sys_print_template` | `sys.print_template` | Grid:sysPrintTemplates / Print | set_default, unset_default | 已完成 |
| 2 | `SynieCore.Files.File` | `sys_file` | `sys.file` | Grid:sysFiles / Print | — | 已完成 |
| 2 | `SynieCore.Files.Attachment` | `sys_attachment` | `sys.file` | — | — | 已完成 |
| 2 | `SynieCore.Files.StorageEndpoint` | `sys_storage` | `sys.storage` | Grid:sysStorages / Print | set_default, unset_default | 已完成 |

## 完成定义

资源状态只能在 Meta 快照、sqlc/模块、OpenAPI、前端 Resource Client、权限拒绝与行为契约、
API/E2E 冒烟均有证据后改为“已完成”。过账模块还必须记录 A/B/C/D 事务表面并证明投影列
只能由模块路径写入。

当前严格进度为 **100/100**。PR-2.15 的标准与委外履约 10 资源、PR-2.16 的销售/采购对账
头行、公司默认过账科目与统一订单收发货历史 6 资源、PR-2.17 的制造主数据与制造执行
12 资源、PR-2.18 的操作日志、待办和用户痕迹 3 资源、PR-2.19 的考勤与薪酬 7 资源，以及
PR-2.20 的资金银行、发票、费用报销和承兑票据 12 资源，均已取得迁移前快照、Go/sqlc、
OpenAPI、REST 客户端、权限/行为/并发契约、真实 PostgreSQL、REST 与 Chromium 证据并改为
“已完成”。权威 Domain 注册的 100 个资源均已逐一满足完成定义。
