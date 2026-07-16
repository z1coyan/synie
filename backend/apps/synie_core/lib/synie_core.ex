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
      list SynieCore.Sales.Customer, :sal_customers, :read, paginate_with: :offset
      list SynieCore.Purchase.Supplier, :pur_suppliers, :read, paginate_with: :offset
      list SynieCore.Hr.Employee, :hr_employees, :read, paginate_with: :offset
      list SynieCore.Inv.MaterialCategory, :inv_material_categories, :read, paginate_with: :offset
      list SynieCore.Hr.AttendancePunch, :hr_attendance_punches, :read, paginate_with: :offset
      list SynieCore.Hr.AttendanceImport, :hr_attendance_imports, :read, paginate_with: :offset
      list SynieCore.Hr.AttendanceDay, :hr_attendance_days, :read, paginate_with: :offset

      list SynieCore.Hr.AttendanceCorrection, :hr_attendance_corrections, :read,
        paginate_with: :offset

      # 月度考勤汇总(供工资):按月聚合,不落库
      action SynieCore.Hr.AttendanceDay, :hr_attendance_month_summary, :month_summary
      list SynieCore.Audit.Log, :sys_audit_logs, :read, paginate_with: :offset
      list SynieCore.Numbering.Rule, :sys_numbering_rules, :read, paginate_with: :offset
      list SynieCore.Numbering.Counter, :sys_numbering_counters, :read, paginate_with: :offset
      list SynieCore.Files.Attachment, :sys_attachments, :read, paginate_with: :offset
      list SynieCore.Acc.GlEntry, :acc_gl_entries, :read, paginate_with: :offset
      list SynieCore.Acc.GlJournal, :acc_gl_journals, :read, paginate_with: :offset
      list SynieCore.Acc.GlJournalLine, :acc_gl_journal_lines, :read, paginate_with: :offset
      list SynieCore.Acc.BankAccount, :acc_bank_accounts, :read, paginate_with: :offset
      list SynieCore.Acc.BankTransaction, :acc_bank_transactions, :read, paginate_with: :offset

      list SynieCore.Acc.BankImportTemplate, :acc_bank_import_templates, :read,
        paginate_with: :offset

      list SynieCore.Acc.BankImport, :acc_bank_imports, :read, paginate_with: :offset
      list SynieCore.Acc.BankImportItem, :acc_bank_import_items, :read, paginate_with: :offset
      list SynieCore.Acc.VatInvoice, :acc_vat_invoices, :read, paginate_with: :offset
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

      create SynieCore.Base.Account, :create_bas_account, :create
      update SynieCore.Base.Account, :update_bas_account, :update
      destroy SynieCore.Base.Account, :destroy_bas_account, :destroy
      action SynieCore.Base.Account, :init_bas_account_from_template, :init_from_template

      create SynieCore.Sales.Customer, :create_sal_customer, :create
      update SynieCore.Sales.Customer, :update_sal_customer, :update
      destroy SynieCore.Sales.Customer, :destroy_sal_customer, :destroy

      create SynieCore.Purchase.Supplier, :create_pur_supplier, :create
      update SynieCore.Purchase.Supplier, :update_pur_supplier, :update
      destroy SynieCore.Purchase.Supplier, :destroy_pur_supplier, :destroy

      create SynieCore.Hr.Employee, :create_hr_employee, :create
      update SynieCore.Hr.Employee, :update_hr_employee, :update
      destroy SynieCore.Hr.Employee, :destroy_hr_employee, :destroy

      create SynieCore.Inv.MaterialCategory, :create_inv_material_category, :create
      update SynieCore.Inv.MaterialCategory, :update_inv_material_category, :update
      destroy SynieCore.Inv.MaterialCategory, :destroy_inv_material_category, :destroy

      # 考勤导入:create 即解析预览,import 执行(打卡记录无独立写 mutation),删除即整批撤销
      create SynieCore.Hr.AttendanceImport, :create_hr_attendance_import, :create
      update SynieCore.Hr.AttendanceImport, :import_hr_attendance_import, :import
      destroy SynieCore.Hr.AttendanceImport, :destroy_hr_attendance_import, :destroy

      create SynieCore.Hr.AttendanceCorrection, :create_hr_attendance_correction, :create
      update SynieCore.Hr.AttendanceCorrection, :update_hr_attendance_correction, :update
      destroy SynieCore.Hr.AttendanceCorrection, :destroy_hr_attendance_correction, :destroy
      # 区间重算兜底(导入/补卡已自动重算)
      action SynieCore.Hr.AttendanceDay, :recalc_hr_attendance_days, :recalc

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
    resource SynieCore.Base.Account
    resource SynieCore.Sales.Customer
    resource SynieCore.Purchase.Supplier
    resource SynieCore.Hr.Employee
    resource SynieCore.Inv.MaterialCategory
    resource SynieCore.Hr.AttendancePunch
    resource SynieCore.Hr.AttendanceImport
    resource SynieCore.Hr.AttendanceDay
    resource SynieCore.Hr.AttendanceCorrection
    resource SynieCore.Acc.GlEntry
    resource SynieCore.Acc.GlJournal
    resource SynieCore.Acc.GlJournalLine
    resource SynieCore.Acc.BankAccount
    resource SynieCore.Acc.BankTransaction
    resource SynieCore.Acc.BankImportTemplate
    resource SynieCore.Acc.BankImport
    resource SynieCore.Acc.BankImportItem
    resource SynieCore.Acc.VatInvoice
    resource SynieCore.Acc.Bill
    resource SynieCore.Acc.BillTransaction
    resource SynieCore.Acc.BillHolding
    resource SynieCore.Acc.BankReconciliation
    resource SynieCore.Acc.Setting
    resource SynieCore.Audit.Log
    resource SynieCore.Numbering.Rule
    resource SynieCore.Numbering.Counter
    resource SynieCore.Files.File
    resource SynieCore.Files.Attachment
    resource SynieCore.Files.StorageEndpoint
  end
end
