defmodule SynieCore do
  use Ash.Domain,
    extensions: [AshGraphql.Domain]

  graphql do
    queries do
      # 约定:list 查询一律 offset 分页,不留扁平列表(见 backend/AGENTS.md)
      list SynieCore.Accounts.User, :sys_users, :read, paginate_with: :offset
      list SynieCore.Authz.Role, :sys_roles, :read, paginate_with: :offset
      list SynieCore.Authz.UserRole, :sys_user_roles, :read, paginate_with: :offset
      list SynieCore.Authz.RolePermission, :sys_role_permissions, :read, paginate_with: :offset
      list SynieCore.Authz.UserCompany, :sys_user_companies, :read, paginate_with: :offset
      list SynieCore.Base.Company, :bas_companies, :read, paginate_with: :offset
      list SynieCore.Base.Unit, :bas_units, :read, paginate_with: :offset
      list SynieCore.Base.Currency, :bas_currencies, :read, paginate_with: :offset
      list SynieCore.Base.Account, :bas_accounts, :read, paginate_with: :offset
      list SynieCore.Base.MarketInstrument, :bas_market_instruments, :read, paginate_with: :offset

      list SynieCore.Base.MarketPricePoint, :bas_market_price_points, :read,
        paginate_with: :offset

      # 行情页图区:可绘图品种 + 多品种时序(价点 read 权限)
      action SynieCore.Base.MarketPricePoint, :bas_market_chart_instruments, :chart_instruments
      action SynieCore.Base.MarketPricePoint, :bas_market_price_series, :price_series

      list SynieCore.Sales.Customer, :sal_customers, :read, paginate_with: :offset
      list SynieCore.Sales.Order, :sal_orders, :read, paginate_with: :offset
      list SynieCore.Sales.OrderItem, :sal_order_items, :read, paginate_with: :offset
      list SynieCore.Sales.Delivery, :sal_deliveries, :read, paginate_with: :offset
      list SynieCore.Sales.DeliveryItem, :sal_delivery_items, :read, paginate_with: :offset
      list SynieCore.Sales.Reconciliation, :sal_reconciliations, :read, paginate_with: :offset

      list SynieCore.Sales.ReconciliationItem, :sal_reconciliation_items, :read,
        paginate_with: :offset

      list SynieCore.Sales.Quotation, :sal_quotations, :read, paginate_with: :offset
      list SynieCore.Sales.QuotationItem, :sal_quotation_items, :read, paginate_with: :offset
      list SynieCore.Sales.QuotationTier, :sal_quotation_tiers, :read, paginate_with: :offset

      # 供应链设置(sal_setting)是单行表,read_one 免分页(同 acc_setting 先例)
      read_one SynieCore.Sales.Setting, :sal_setting, :read

      # 公司默认过账科目(一公司一行);设置页按公司 filter 取
      list SynieCore.Sales.CompanyAccountDefault, :sal_company_account_defaults, :read,
        paginate_with: :offset

      # 系统设置(行情拉取配置等);初始化旗标不经 GraphQL 写
      read_one SynieCore.Sys.Setting, :sys_setting, :read
      list SynieCore.Purchase.Supplier, :pur_suppliers, :read, paginate_with: :offset
      list SynieCore.Purchase.Quotation, :pur_quotations, :read, paginate_with: :offset
      list SynieCore.Purchase.QuotationItem, :pur_quotation_items, :read, paginate_with: :offset

      list SynieCore.Purchase.QuotationTier, :pur_quotation_tiers, :read, paginate_with: :offset

      list SynieCore.Purchase.Order, :pur_orders, :read, paginate_with: :offset
      list SynieCore.Purchase.OrderItem, :pur_order_items, :read, paginate_with: :offset
      list SynieCore.Purchase.Receipt, :pur_receipts, :read, paginate_with: :offset
      list SynieCore.Purchase.ReceiptItem, :pur_receipt_items, :read, paginate_with: :offset
      list SynieCore.Purchase.Reconciliation, :pur_reconciliations, :read, paginate_with: :offset

      list SynieCore.Purchase.ReconciliationItem, :pur_reconciliation_items, :read,
        paginate_with: :offset

      list SynieCore.Hr.Employee, :hr_employees, :read, paginate_with: :offset
      list SynieCore.Inv.MaterialCategory, :inv_material_categories, :read, paginate_with: :offset
      list SynieCore.Inv.Material, :inv_materials, :read, paginate_with: :offset
      list SynieCore.Inv.MaterialUnit, :inv_material_units, :read, paginate_with: :offset
      list SynieCore.Inv.Warehouse, :inv_warehouses, :read, paginate_with: :offset
      list SynieCore.Inv.StockEntry, :inv_stock_entries, :read, paginate_with: :offset
      list SynieCore.Inv.StockDoc, :inv_stock_docs, :read, paginate_with: :offset
      list SynieCore.Inv.StockDocItem, :inv_stock_doc_items, :read, paginate_with: :offset
      list SynieCore.Inv.StockTransfer, :inv_stock_transfers, :read, paginate_with: :offset

      list SynieCore.Inv.StockTransferItem, :inv_stock_transfer_items, :read,
        paginate_with: :offset

      list SynieCore.Inv.StockCount, :inv_stock_counts, :read, paginate_with: :offset
      list SynieCore.Inv.StockCountItem, :inv_stock_count_items, :read, paginate_with: :offset

      # 库存余额表:仓×物料聚合(未作废分录、截至日口径),不落库
      action SynieCore.Inv.StockEntry, :inv_stock_balance, :stock_balance
      list SynieCore.Mfg.Operation, :mfg_operations, :read, paginate_with: :offset
      list SynieCore.Mfg.ProcessTemplate, :mfg_process_templates, :read, paginate_with: :offset

      list SynieCore.Mfg.ProcessTemplateItem, :mfg_process_template_items, :read,
        paginate_with: :offset

      list SynieCore.Mfg.Bom, :mfg_boms, :read, paginate_with: :offset
      list SynieCore.Mfg.BomComponent, :mfg_bom_components, :read, paginate_with: :offset
      list SynieCore.Mfg.BomRoute, :mfg_bom_routes, :read, paginate_with: :offset
      list SynieCore.Mfg.BomByproduct, :mfg_bom_byproducts, :read, paginate_with: :offset
      list SynieCore.Hr.AttendancePunch, :hr_attendance_punches, :read, paginate_with: :offset
      list SynieCore.Hr.AttendanceImport, :hr_attendance_imports, :read, paginate_with: :offset
      list SynieCore.Hr.AttendanceDay, :hr_attendance_days, :read, paginate_with: :offset

      list SynieCore.Hr.AttendanceCorrection, :hr_attendance_corrections, :read,
        paginate_with: :offset

      # 月度考勤汇总(供工资):按月聚合,不落库
      action SynieCore.Hr.AttendanceDay, :hr_attendance_month_summary, :month_summary
      list SynieCore.Hr.Payroll, :hr_payrolls, :read, paginate_with: :offset
      list SynieCore.Hr.PayrollPayment, :hr_payroll_payments, :read, paginate_with: :offset
      list SynieCore.Hr.EmployeeLoan, :hr_employee_loans, :read, paginate_with: :offset

      # 月度薪资统计(列表统计条)与员工借款余额汇总:读能力衍生视图,不落库
      action SynieCore.Hr.Payroll, :hr_payroll_month_stats, :month_stats
      action SynieCore.Hr.EmployeeLoan, :hr_employee_loan_balances, :balances
      list SynieCore.Audit.Log, :sys_audit_logs, :read, paginate_with: :offset
      list SynieCore.Numbering.Rule, :sys_numbering_rules, :read, paginate_with: :offset
      list SynieCore.Numbering.Counter, :sys_numbering_counters, :read, paginate_with: :offset
      list SynieCore.Files.Attachment, :sys_attachments, :read, paginate_with: :offset
      list SynieCore.Acc.GlEntry, :acc_gl_entries, :read, paginate_with: :offset

      # 应收应付报表:截至日按对手×科目角色轧差,不落库
      action SynieCore.Acc.GlEntry, :acc_ar_ap_report, :ar_ap_report
      list SynieCore.Acc.GlJournal, :acc_gl_journals, :read, paginate_with: :offset
      list SynieCore.Acc.GlJournalLine, :acc_gl_journal_lines, :read, paginate_with: :offset
      list SynieCore.Acc.BankAccount, :acc_bank_accounts, :read, paginate_with: :offset
      list SynieCore.Acc.BankTransaction, :acc_bank_transactions, :read, paginate_with: :offset

      list SynieCore.Acc.BankImportTemplate, :acc_bank_import_templates, :read,
        paginate_with: :offset

      list SynieCore.Acc.BankImport, :acc_bank_imports, :read, paginate_with: :offset
      list SynieCore.Acc.BankImportItem, :acc_bank_import_items, :read, paginate_with: :offset
      list SynieCore.Acc.VatInvoice, :acc_vat_invoices, :read, paginate_with: :offset
      list SynieCore.Acc.ExpenseReport, :acc_expense_reports, :read, paginate_with: :offset

      list SynieCore.Acc.ExpenseReportItem, :acc_expense_report_items, :read,
        paginate_with: :offset

      list SynieCore.Acc.Bill, :acc_bills, :read, paginate_with: :offset
      list SynieCore.Acc.BillTransaction, :acc_bill_transactions, :read, paginate_with: :offset
      list SynieCore.Acc.BillHolding, :acc_bill_holdings, :read, paginate_with: :offset

      list SynieCore.Acc.BankReconciliation, :acc_bank_reconciliations, :read,
        paginate_with: :offset

      # 对账剩余额度:选中凭证后预填默认对账金额
      action SynieCore.Acc.BankReconciliation, :acc_bank_reconciliation_remaining, :remaining

      # 文件元数据列表:导入记录等 file_id 外键的速览/联查用(字节仍走 REST)
      list SynieCore.Files.File, :sys_files, :read, paginate_with: :offset

      list SynieCore.Files.StorageEndpoint, :sys_storages, :read, paginate_with: :offset

      # 财务设置是单行表,read_one 免分页;配置态布尔登录即可查(OCR 按钮防呆)
      read_one SynieCore.Acc.Setting, :acc_setting, :read
      action SynieCore.Acc.Setting, :acc_ocr_configured, :ocr_configured
    end

    mutations do
      # 用户的 create / 重置密码走 schema.ex 手写 mutation(需要一次性返回明文密码)
      update SynieCore.Accounts.User, :update_sys_user, :update
      destroy SynieCore.Accounts.User, :destroy_sys_user, :destroy

      create SynieCore.Authz.Role, :create_sys_role, :create
      update SynieCore.Authz.Role, :update_sys_role, :update
      destroy SynieCore.Authz.Role, :destroy_sys_role, :destroy

      create SynieCore.Authz.UserRole, :create_sys_user_role, :create
      destroy SynieCore.Authz.UserRole, :destroy_sys_user_role, :destroy

      create SynieCore.Authz.RolePermission, :create_sys_role_permission, :create
      destroy SynieCore.Authz.RolePermission, :destroy_sys_role_permission, :destroy

      create SynieCore.Base.Company, :create_bas_company, :create
      update SynieCore.Base.Company, :update_bas_company, :update
      destroy SynieCore.Base.Company, :destroy_bas_company, :destroy

      create SynieCore.Authz.UserCompany, :create_sys_user_company, :create
      destroy SynieCore.Authz.UserCompany, :destroy_sys_user_company, :destroy

      create SynieCore.Base.Unit, :create_bas_unit, :create
      update SynieCore.Base.Unit, :update_bas_unit, :update
      destroy SynieCore.Base.Unit, :destroy_bas_unit, :destroy

      create SynieCore.Base.Currency, :create_bas_currency, :create
      update SynieCore.Base.Currency, :update_bas_currency, :update
      destroy SynieCore.Base.Currency, :destroy_bas_currency, :destroy

      create SynieCore.Base.MarketInstrument, :create_bas_market_instrument, :create
      update SynieCore.Base.MarketInstrument, :update_bas_market_instrument, :update
      destroy SynieCore.Base.MarketInstrument, :destroy_bas_market_instrument, :destroy

      create SynieCore.Base.MarketPricePoint, :create_bas_market_price_point, :create
      update SynieCore.Base.MarketPricePoint, :void_bas_market_price_point, :void
      action SynieCore.Base.MarketPricePoint, :refresh_bas_market_price_points, :refresh

      create SynieCore.Base.Account, :create_bas_account, :create
      update SynieCore.Base.Account, :update_bas_account, :update
      destroy SynieCore.Base.Account, :destroy_bas_account, :destroy
      action SynieCore.Base.Account, :init_bas_account_from_template, :init_from_template

      create SynieCore.Sales.Customer, :create_sal_customer, :create
      update SynieCore.Sales.Customer, :update_sal_customer, :update
      destroy SynieCore.Sales.Customer, :destroy_sal_customer, :destroy

      # 销售订单:状态翻转走 audit/close/void 独立 mutation;行随单头权限码
      create SynieCore.Sales.Order, :create_sal_order, :create
      update SynieCore.Sales.Order, :update_sal_order, :update
      destroy SynieCore.Sales.Order, :destroy_sal_order, :destroy
      update SynieCore.Sales.Order, :audit_sal_order, :audit
      update SynieCore.Sales.Order, :close_sal_order, :close
      update SynieCore.Sales.Order, :void_sal_order, :void

      create SynieCore.Sales.OrderItem, :create_sal_order_item, :create
      update SynieCore.Sales.OrderItem, :update_sal_order_item, :update
      destroy SynieCore.Sales.OrderItem, :destroy_sal_order_item, :destroy

      # 销售发货单:审核派生库存+总账+已发数量;作废回滚;行随单头权限码
      create SynieCore.Sales.Delivery, :create_sal_delivery, :create
      update SynieCore.Sales.Delivery, :update_sal_delivery, :update
      destroy SynieCore.Sales.Delivery, :destroy_sal_delivery, :destroy
      update SynieCore.Sales.Delivery, :audit_sal_delivery, :audit
      update SynieCore.Sales.Delivery, :void_sal_delivery, :void

      create SynieCore.Sales.DeliveryItem, :create_sal_delivery_item, :create
      update SynieCore.Sales.DeliveryItem, :update_sal_delivery_item, :update
      destroy SynieCore.Sales.DeliveryItem, :destroy_sal_delivery_item, :destroy

      # 销售对账单:常规单 confirm/unconfirm,赠送/样品单 audit(结单)/void;行随单头权限码
      create SynieCore.Sales.Reconciliation, :create_sal_reconciliation, :create
      update SynieCore.Sales.Reconciliation, :update_sal_reconciliation, :update
      destroy SynieCore.Sales.Reconciliation, :destroy_sal_reconciliation, :destroy
      update SynieCore.Sales.Reconciliation, :confirm_sal_reconciliation, :confirm
      update SynieCore.Sales.Reconciliation, :unconfirm_sal_reconciliation, :unconfirm
      update SynieCore.Sales.Reconciliation, :audit_sal_reconciliation, :audit
      update SynieCore.Sales.Reconciliation, :void_sal_reconciliation, :void

      create SynieCore.Sales.ReconciliationItem, :create_sal_reconciliation_item, :create
      update SynieCore.Sales.ReconciliationItem, :update_sal_reconciliation_item, :update
      destroy SynieCore.Sales.ReconciliationItem, :destroy_sal_reconciliation_item, :destroy

      # 销售报价单:状态翻转走 audit/void 独立 mutation;条目与价格档随单头权限码
      create SynieCore.Sales.Quotation, :create_sal_quotation, :create
      update SynieCore.Sales.Quotation, :update_sal_quotation, :update
      destroy SynieCore.Sales.Quotation, :destroy_sal_quotation, :destroy
      update SynieCore.Sales.Quotation, :audit_sal_quotation, :audit
      update SynieCore.Sales.Quotation, :void_sal_quotation, :void

      create SynieCore.Sales.QuotationItem, :create_sal_quotation_item, :create
      update SynieCore.Sales.QuotationItem, :update_sal_quotation_item, :update
      destroy SynieCore.Sales.QuotationItem, :destroy_sal_quotation_item, :destroy

      create SynieCore.Sales.QuotationTier, :create_sal_quotation_tier, :create
      update SynieCore.Sales.QuotationTier, :update_sal_quotation_tier, :update
      destroy SynieCore.Sales.QuotationTier, :destroy_sal_quotation_tier, :destroy

      update SynieCore.Sales.Setting, :update_sal_setting, :update

      create SynieCore.Sales.CompanyAccountDefault, :create_sal_company_account_default, :create
      update SynieCore.Sales.CompanyAccountDefault, :update_sal_company_account_default, :update
      update SynieCore.Sys.Setting, :update_sys_setting, :update

      create SynieCore.Purchase.Supplier, :create_pur_supplier, :create
      update SynieCore.Purchase.Supplier, :update_pur_supplier, :update
      destroy SynieCore.Purchase.Supplier, :destroy_pur_supplier, :destroy

      # 采购报价单:状态翻转走 audit/void 独立 mutation;条目与价格档随单头权限码
      create SynieCore.Purchase.Quotation, :create_pur_quotation, :create
      update SynieCore.Purchase.Quotation, :update_pur_quotation, :update
      destroy SynieCore.Purchase.Quotation, :destroy_pur_quotation, :destroy
      update SynieCore.Purchase.Quotation, :audit_pur_quotation, :audit
      update SynieCore.Purchase.Quotation, :void_pur_quotation, :void

      create SynieCore.Purchase.QuotationItem, :create_pur_quotation_item, :create
      update SynieCore.Purchase.QuotationItem, :update_pur_quotation_item, :update
      destroy SynieCore.Purchase.QuotationItem, :destroy_pur_quotation_item, :destroy

      create SynieCore.Purchase.QuotationTier, :create_pur_quotation_tier, :create
      update SynieCore.Purchase.QuotationTier, :update_pur_quotation_tier, :update
      destroy SynieCore.Purchase.QuotationTier, :destroy_pur_quotation_tier, :destroy

      # 采购订单:状态翻转走 audit/close/void 独立 mutation;行随单头权限码
      create SynieCore.Purchase.Order, :create_pur_order, :create
      update SynieCore.Purchase.Order, :update_pur_order, :update
      destroy SynieCore.Purchase.Order, :destroy_pur_order, :destroy
      update SynieCore.Purchase.Order, :audit_pur_order, :audit
      update SynieCore.Purchase.Order, :close_pur_order, :close
      update SynieCore.Purchase.Order, :void_pur_order, :void

      create SynieCore.Purchase.OrderItem, :create_pur_order_item, :create
      update SynieCore.Purchase.OrderItem, :update_pur_order_item, :update
      destroy SynieCore.Purchase.OrderItem, :destroy_pur_order_item, :destroy

      # 采购入库单:审核派生库存+总账+已收数量;作废回滚;行随单头权限码
      create SynieCore.Purchase.Receipt, :create_pur_receipt, :create
      update SynieCore.Purchase.Receipt, :update_pur_receipt, :update
      destroy SynieCore.Purchase.Receipt, :destroy_pur_receipt, :destroy
      update SynieCore.Purchase.Receipt, :audit_pur_receipt, :audit
      update SynieCore.Purchase.Receipt, :void_pur_receipt, :void

      create SynieCore.Purchase.ReceiptItem, :create_pur_receipt_item, :create
      update SynieCore.Purchase.ReceiptItem, :update_pur_receipt_item, :update
      destroy SynieCore.Purchase.ReceiptItem, :destroy_pur_receipt_item, :destroy

      # 采购对账单:常规单 confirm/unconfirm,赠送/样品单 audit(结单)/void;行随单头权限码
      create SynieCore.Purchase.Reconciliation, :create_pur_reconciliation, :create
      update SynieCore.Purchase.Reconciliation, :update_pur_reconciliation, :update
      destroy SynieCore.Purchase.Reconciliation, :destroy_pur_reconciliation, :destroy
      update SynieCore.Purchase.Reconciliation, :confirm_pur_reconciliation, :confirm
      update SynieCore.Purchase.Reconciliation, :unconfirm_pur_reconciliation, :unconfirm
      update SynieCore.Purchase.Reconciliation, :audit_pur_reconciliation, :audit
      update SynieCore.Purchase.Reconciliation, :void_pur_reconciliation, :void

      create SynieCore.Purchase.ReconciliationItem, :create_pur_reconciliation_item, :create
      update SynieCore.Purchase.ReconciliationItem, :update_pur_reconciliation_item, :update
      destroy SynieCore.Purchase.ReconciliationItem, :destroy_pur_reconciliation_item, :destroy

      create SynieCore.Hr.Employee, :create_hr_employee, :create
      update SynieCore.Hr.Employee, :update_hr_employee, :update
      destroy SynieCore.Hr.Employee, :destroy_hr_employee, :destroy

      # 生产域:行子表随主表权限码(同物料单位转换先例);BOM 路线从模板带入复用 update 码
      create SynieCore.Mfg.Operation, :create_mfg_operation, :create
      update SynieCore.Mfg.Operation, :update_mfg_operation, :update
      destroy SynieCore.Mfg.Operation, :destroy_mfg_operation, :destroy

      create SynieCore.Mfg.ProcessTemplate, :create_mfg_process_template, :create
      update SynieCore.Mfg.ProcessTemplate, :update_mfg_process_template, :update
      destroy SynieCore.Mfg.ProcessTemplate, :destroy_mfg_process_template, :destroy

      create SynieCore.Mfg.ProcessTemplateItem, :create_mfg_process_template_item, :create
      update SynieCore.Mfg.ProcessTemplateItem, :update_mfg_process_template_item, :update
      destroy SynieCore.Mfg.ProcessTemplateItem, :destroy_mfg_process_template_item, :destroy

      create SynieCore.Mfg.Bom, :create_mfg_bom, :create
      update SynieCore.Mfg.Bom, :update_mfg_bom, :update
      destroy SynieCore.Mfg.Bom, :destroy_mfg_bom, :destroy
      update SynieCore.Mfg.Bom, :apply_mfg_bom_route_template, :apply_route_template

      create SynieCore.Mfg.BomComponent, :create_mfg_bom_component, :create
      update SynieCore.Mfg.BomComponent, :update_mfg_bom_component, :update
      destroy SynieCore.Mfg.BomComponent, :destroy_mfg_bom_component, :destroy

      create SynieCore.Mfg.BomRoute, :create_mfg_bom_route, :create
      update SynieCore.Mfg.BomRoute, :update_mfg_bom_route, :update
      destroy SynieCore.Mfg.BomRoute, :destroy_mfg_bom_route, :destroy

      create SynieCore.Mfg.BomByproduct, :create_mfg_bom_byproduct, :create
      update SynieCore.Mfg.BomByproduct, :update_mfg_bom_byproduct, :update
      destroy SynieCore.Mfg.BomByproduct, :destroy_mfg_bom_byproduct, :destroy

      create SynieCore.Inv.MaterialCategory, :create_inv_material_category, :create
      update SynieCore.Inv.MaterialCategory, :update_inv_material_category, :update
      destroy SynieCore.Inv.MaterialCategory, :destroy_inv_material_category, :destroy

      create SynieCore.Inv.Material, :create_inv_material, :create
      update SynieCore.Inv.Material, :update_inv_material, :update
      destroy SynieCore.Inv.Material, :destroy_inv_material, :destroy

      create SynieCore.Inv.MaterialUnit, :create_inv_material_unit, :create
      update SynieCore.Inv.MaterialUnit, :update_inv_material_unit, :update
      destroy SynieCore.Inv.MaterialUnit, :destroy_inv_material_unit, :destroy

      create SynieCore.Inv.Warehouse, :create_inv_warehouse, :create
      update SynieCore.Inv.Warehouse, :update_inv_warehouse, :update
      destroy SynieCore.Inv.Warehouse, :destroy_inv_warehouse, :destroy
      action SynieCore.Inv.Warehouse, :seed_inv_warehouse_defaults, :seed_defaults

      # 手工出入库单:状态翻转走 audit/void 独立 mutation;单据行随单头权限码(同销售订单先例)
      create SynieCore.Inv.StockDoc, :create_inv_stock_doc, :create
      update SynieCore.Inv.StockDoc, :update_inv_stock_doc, :update
      destroy SynieCore.Inv.StockDoc, :destroy_inv_stock_doc, :destroy
      update SynieCore.Inv.StockDoc, :audit_inv_stock_doc, :audit
      update SynieCore.Inv.StockDoc, :void_inv_stock_doc, :void

      create SynieCore.Inv.StockDocItem, :create_inv_stock_doc_item, :create
      update SynieCore.Inv.StockDocItem, :update_inv_stock_doc_item, :update
      destroy SynieCore.Inv.StockDocItem, :destroy_inv_stock_doc_item, :destroy

      # 调拨单:状态翻转走 ship/receive 独立 mutation;单据行随单头权限码(同手工出入库单先例)
      create SynieCore.Inv.StockTransfer, :create_inv_stock_transfer, :create
      update SynieCore.Inv.StockTransfer, :update_inv_stock_transfer, :update
      destroy SynieCore.Inv.StockTransfer, :destroy_inv_stock_transfer, :destroy
      update SynieCore.Inv.StockTransfer, :ship_inv_stock_transfer, :ship
      update SynieCore.Inv.StockTransfer, :receive_inv_stock_transfer, :receive

      create SynieCore.Inv.StockTransferItem, :create_inv_stock_transfer_item, :create
      update SynieCore.Inv.StockTransferItem, :update_inv_stock_transfer_item, :update
      destroy SynieCore.Inv.StockTransferItem, :destroy_inv_stock_transfer_item, :destroy

      # 库存盘点单:状态翻转走 approve/cancel 独立 mutation;refresh 刷新账面数;盘点行随单头权限码(同手工出入库单先例)
      create SynieCore.Inv.StockCount, :create_inv_stock_count, :create
      update SynieCore.Inv.StockCount, :update_inv_stock_count, :update
      destroy SynieCore.Inv.StockCount, :destroy_inv_stock_count, :destroy
      update SynieCore.Inv.StockCount, :refresh_inv_stock_count, :refresh
      update SynieCore.Inv.StockCount, :approve_inv_stock_count, :approve
      update SynieCore.Inv.StockCount, :cancel_inv_stock_count, :cancel

      create SynieCore.Inv.StockCountItem, :create_inv_stock_count_item, :create
      update SynieCore.Inv.StockCountItem, :update_inv_stock_count_item, :update
      destroy SynieCore.Inv.StockCountItem, :destroy_inv_stock_count_item, :destroy

      # 考勤导入:create 即解析预览,import 执行(打卡记录无独立写 mutation),删除即整批撤销
      create SynieCore.Hr.AttendanceImport, :create_hr_attendance_import, :create
      update SynieCore.Hr.AttendanceImport, :import_hr_attendance_import, :import
      destroy SynieCore.Hr.AttendanceImport, :destroy_hr_attendance_import, :destroy

      create SynieCore.Hr.AttendanceCorrection, :create_hr_attendance_correction, :create
      update SynieCore.Hr.AttendanceCorrection, :update_hr_attendance_correction, :update
      destroy SynieCore.Hr.AttendanceCorrection, :destroy_hr_attendance_correction, :destroy
      # 区间重算兜底(导入/补卡已自动重算)
      action SynieCore.Hr.AttendanceDay, :recalc_hr_attendance_days, :recalc

      # 工资单:generate 按月批量生成、refresh 重取快照;状态翻转由发放记录联动,无独立 mutation
      create SynieCore.Hr.Payroll, :create_hr_payroll, :create
      update SynieCore.Hr.Payroll, :update_hr_payroll, :update
      update SynieCore.Hr.Payroll, :refresh_hr_payroll, :refresh
      destroy SynieCore.Hr.Payroll, :destroy_hr_payroll, :destroy
      action SynieCore.Hr.Payroll, :generate_hr_payrolls, :generate

      # 发放记录:创建即发放(翻转工资单),不可改只可删重录;pay_remaining 一键发未发差额
      create SynieCore.Hr.PayrollPayment, :create_hr_payroll_payment, :create
      create SynieCore.Hr.PayrollPayment, :pay_remaining_hr_payroll_payment, :pay_remaining
      destroy SynieCore.Hr.PayrollPayment, :destroy_hr_payroll_payment, :destroy

      create SynieCore.Hr.EmployeeLoan, :create_hr_employee_loan, :create
      update SynieCore.Hr.EmployeeLoan, :update_hr_employee_loan, :update
      destroy SynieCore.Hr.EmployeeLoan, :destroy_hr_employee_loan, :destroy

      # 文件的创建走 REST 上传端点(multipart 不过 GraphQL),这里只注册删除与解挂
      destroy SynieCore.Files.File, :destroy_sys_file, :destroy
      destroy SynieCore.Files.Attachment, :destroy_sys_attachment, :destroy

      create SynieCore.Files.StorageEndpoint, :create_sys_storage, :create
      update SynieCore.Files.StorageEndpoint, :update_sys_storage, :update
      update SynieCore.Files.StorageEndpoint, :set_default_sys_storage, :set_default
      destroy SynieCore.Files.StorageEndpoint, :destroy_sys_storage, :destroy

      create SynieCore.Numbering.Rule, :create_sys_numbering_rule, :create
      update SynieCore.Numbering.Rule, :update_sys_numbering_rule, :update
      destroy SynieCore.Numbering.Rule, :destroy_sys_numbering_rule, :destroy
      # 计数器行由取号自动创建,只暴露改当前值
      update SynieCore.Numbering.Counter, :update_sys_numbering_counter, :update

      create SynieCore.Acc.GlJournal, :create_acc_gl_journal, :create
      update SynieCore.Acc.GlJournal, :update_acc_gl_journal, :update
      destroy SynieCore.Acc.GlJournal, :destroy_acc_gl_journal, :destroy
      update SynieCore.Acc.GlJournal, :audit_acc_gl_journal, :audit
      update SynieCore.Acc.GlJournal, :cancel_acc_gl_journal, :cancel

      create SynieCore.Acc.GlJournalLine, :create_acc_gl_journal_line, :create
      update SynieCore.Acc.GlJournalLine, :update_acc_gl_journal_line, :update
      destroy SynieCore.Acc.GlJournalLine, :destroy_acc_gl_journal_line, :destroy

      create SynieCore.Acc.BankAccount, :create_acc_bank_account, :create
      update SynieCore.Acc.BankAccount, :update_acc_bank_account, :update
      destroy SynieCore.Acc.BankAccount, :destroy_acc_bank_account, :destroy

      create SynieCore.Acc.BankTransaction, :create_acc_bank_transaction, :create
      update SynieCore.Acc.BankTransaction, :update_acc_bank_transaction, :update
      destroy SynieCore.Acc.BankTransaction, :destroy_acc_bank_transaction, :destroy

      create SynieCore.Acc.BankImportTemplate, :create_acc_bank_import_template, :create
      update SynieCore.Acc.BankImportTemplate, :update_acc_bank_import_template, :update
      destroy SynieCore.Acc.BankImportTemplate, :destroy_acc_bank_import_template, :destroy

      # 导入记录:create 即解析;无 header update(解析后锁定);行的 create 是解析内部路径
      create SynieCore.Acc.BankImport, :create_acc_bank_import, :create
      update SynieCore.Acc.BankImport, :import_acc_bank_import, :import
      destroy SynieCore.Acc.BankImport, :destroy_acc_bank_import, :destroy
      update SynieCore.Acc.BankImportItem, :update_acc_bank_import_item, :update
      destroy SynieCore.Acc.BankImportItem, :destroy_acc_bank_import_item, :destroy

      create SynieCore.Acc.VatInvoice, :create_acc_vat_invoice, :create
      update SynieCore.Acc.VatInvoice, :update_acc_vat_invoice, :update
      destroy SynieCore.Acc.VatInvoice, :destroy_acc_vat_invoice, :destroy
      update SynieCore.Acc.VatInvoice, :audit_acc_vat_invoice, :audit
      update SynieCore.Acc.VatInvoice, :void_acc_vat_invoice, :void
      update SynieCore.Acc.VatInvoice, :reverse_acc_vat_invoice, :reverse

      create SynieCore.Acc.ExpenseReport, :create_acc_expense_report, :create
      update SynieCore.Acc.ExpenseReport, :update_acc_expense_report, :update
      destroy SynieCore.Acc.ExpenseReport, :destroy_acc_expense_report, :destroy
      update SynieCore.Acc.ExpenseReport, :audit_acc_expense_report, :audit
      update SynieCore.Acc.ExpenseReport, :void_acc_expense_report, :void

      create SynieCore.Acc.ExpenseReportItem, :create_acc_expense_report_item, :create
      update SynieCore.Acc.ExpenseReportItem, :update_acc_expense_report_item, :update
      destroy SynieCore.Acc.ExpenseReportItem, :destroy_acc_expense_report_item, :destroy

      # 建档走内部 :register(接收交易时顺带注册),无 create mutation
      update SynieCore.Acc.Bill, :update_acc_bill, :update
      destroy SynieCore.Acc.Bill, :destroy_acc_bill, :destroy

      create SynieCore.Acc.BillTransaction, :create_acc_bill_transaction, :create
      update SynieCore.Acc.BillTransaction, :update_acc_bill_transaction, :update
      destroy SynieCore.Acc.BillTransaction, :destroy_acc_bill_transaction, :destroy
      update SynieCore.Acc.BillTransaction, :audit_acc_bill_transaction, :audit
      update SynieCore.Acc.BillTransaction, :void_acc_bill_transaction, :void

      create SynieCore.Acc.BankReconciliation, :create_acc_bank_reconciliation, :create

      create SynieCore.Acc.BankReconciliation,
             :quick_create_acc_bank_reconciliation,
             :quick_create

      destroy SynieCore.Acc.BankReconciliation, :destroy_acc_bank_reconciliation, :destroy

      update SynieCore.Acc.Setting, :update_acc_setting, :update

      # OCR 识别是有副作用的外部调用(计费),注册为 mutation;权限复用各自 create 码
      action SynieCore.Acc.VatInvoice, :ocr_acc_vat_invoice, :ocr
      action SynieCore.Acc.BillTransaction, :ocr_acc_bill_transaction, :ocr
    end
  end

  resources do
    resource SynieCore.Accounts.User
    resource SynieCore.Authz.Role
    resource SynieCore.Authz.UserRole
    resource SynieCore.Authz.RolePermission
    resource SynieCore.Authz.UserCompany
    resource SynieCore.Base.Company
    resource SynieCore.Base.Unit
    resource SynieCore.Base.Currency
    resource SynieCore.Base.MarketInstrument
    resource SynieCore.Base.MarketPricePoint
    resource SynieCore.Base.Account
    resource SynieCore.Sales.Customer
    resource SynieCore.Sales.Order
    resource SynieCore.Sales.OrderItem
    resource SynieCore.Sales.Delivery
    resource SynieCore.Sales.DeliveryItem
    resource SynieCore.Sales.Reconciliation
    resource SynieCore.Sales.ReconciliationItem
    resource SynieCore.Sales.Quotation
    resource SynieCore.Sales.QuotationItem
    resource SynieCore.Sales.QuotationTier
    resource SynieCore.Sales.Setting
    resource SynieCore.Sales.CompanyAccountDefault
    resource SynieCore.Purchase.Supplier
    resource SynieCore.Purchase.Quotation
    resource SynieCore.Purchase.QuotationItem
    resource SynieCore.Purchase.QuotationTier
    resource SynieCore.Purchase.Order
    resource SynieCore.Purchase.OrderItem
    resource SynieCore.Purchase.Receipt
    resource SynieCore.Purchase.ReceiptItem
    resource SynieCore.Purchase.Reconciliation
    resource SynieCore.Purchase.ReconciliationItem
    resource SynieCore.Hr.Employee
    resource SynieCore.Mfg.Operation
    resource SynieCore.Mfg.ProcessTemplate
    resource SynieCore.Mfg.ProcessTemplateItem
    resource SynieCore.Mfg.Bom
    resource SynieCore.Mfg.BomComponent
    resource SynieCore.Mfg.BomRoute
    resource SynieCore.Mfg.BomByproduct
    resource SynieCore.Inv.MaterialCategory
    resource SynieCore.Inv.Material
    resource SynieCore.Inv.MaterialUnit
    resource SynieCore.Inv.Warehouse
    resource SynieCore.Inv.StockEntry
    resource SynieCore.Inv.StockDoc
    resource SynieCore.Inv.StockDocItem
    resource SynieCore.Inv.StockTransfer
    resource SynieCore.Inv.StockTransferItem
    resource SynieCore.Inv.StockCount
    resource SynieCore.Inv.StockCountItem
    resource SynieCore.Hr.AttendancePunch
    resource SynieCore.Hr.AttendanceImport
    resource SynieCore.Hr.AttendanceDay
    resource SynieCore.Hr.AttendanceCorrection
    resource SynieCore.Hr.Payroll
    resource SynieCore.Hr.PayrollPayment
    resource SynieCore.Hr.EmployeeLoan
    resource SynieCore.Acc.GlEntry
    resource SynieCore.Acc.GlJournal
    resource SynieCore.Acc.GlJournalLine
    resource SynieCore.Acc.BankAccount
    resource SynieCore.Acc.BankTransaction
    resource SynieCore.Acc.BankImportTemplate
    resource SynieCore.Acc.BankImport
    resource SynieCore.Acc.BankImportItem
    resource SynieCore.Acc.VatInvoice
    resource SynieCore.Acc.ExpenseReport
    resource SynieCore.Acc.ExpenseReportItem
    resource SynieCore.Acc.Bill
    resource SynieCore.Acc.BillTransaction
    resource SynieCore.Acc.BillHolding
    resource SynieCore.Acc.BankReconciliation
    resource SynieCore.Acc.Setting
    resource SynieCore.Audit.Log
    resource SynieCore.Sys.Setting
    resource SynieCore.Numbering.Rule
    resource SynieCore.Numbering.Counter
    resource SynieCore.Files.File
    resource SynieCore.Files.Attachment
    resource SynieCore.Files.StorageEndpoint
  end
end
