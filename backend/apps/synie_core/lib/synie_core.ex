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
      list SynieCore.Audit.Log, :sys_audit_logs, :read, paginate_with: :offset
      list SynieCore.Files.Attachment, :sys_attachments, :read, paginate_with: :offset
      list SynieCore.Acc.GlEntry, :acc_gl_entries, :read, paginate_with: :offset
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

      # 文件的创建走 REST 上传端点(multipart 不过 GraphQL),这里只注册删除与解挂
      destroy SynieCore.Files.File, :destroy_sys_file, :destroy
      destroy SynieCore.Files.Attachment, :destroy_sys_attachment, :destroy
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
    resource SynieCore.Acc.GlEntry
    resource SynieCore.Audit.Log
    resource SynieCore.Files.File
    resource SynieCore.Files.Attachment
  end
end
