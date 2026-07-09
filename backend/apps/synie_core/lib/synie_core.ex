defmodule SynieCore do
  use Ash.Domain,
    extensions: [AshGraphql.Domain]

  graphql do
    queries do
      # 约定:list 查询一律 offset 分页,不留扁平列表(见 backend/AGENTS.md)
      list SynieCore.Authz.Role, :sys_roles, :read, paginate_with: :offset
      list SynieCore.Authz.UserRole, :sys_user_roles, :read, paginate_with: :offset
      list SynieCore.Authz.RolePermission, :sys_role_permissions, :read, paginate_with: :offset
      list SynieCore.Authz.UserCompany, :sys_user_companies, :read, paginate_with: :offset
      list SynieCore.Base.Company, :bas_companies, :read, paginate_with: :offset
      list SynieCore.Base.Unit, :bas_units, :read, paginate_with: :offset
      list SynieCore.Base.Currency, :bas_currencies, :read, paginate_with: :offset
      list SynieCore.Audit.Log, :sys_audit_logs, :read, paginate_with: :offset
    end

    mutations do
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
    resource SynieCore.Audit.Log
  end
end
