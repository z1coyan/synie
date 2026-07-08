defmodule SynieCore do
  use Ash.Domain,
    extensions: [AshGraphql.Domain]

  graphql do
    queries do
      # paginate_with: nil —— 系统资源规模小,直接返回扁平列表,不做分页包装
      list SynieCore.Authz.Role, :sys_roles, :read, paginate_with: nil
      list SynieCore.Authz.UserRole, :sys_user_roles, :read, paginate_with: nil
      list SynieCore.Authz.RolePermission, :sys_role_permissions, :read, paginate_with: nil
      list SynieCore.Authz.UserCompany, :sys_user_companies, :read, paginate_with: nil
      list SynieCore.Org.Company, :sys_companies, :read, paginate_with: nil
      list SynieCore.Base.Unit, :sys_units, :read, paginate_with: nil
      list SynieCore.Base.Currency, :sys_currencies, :read, paginate_with: nil
    end

    mutations do
      create SynieCore.Authz.Role, :create_sys_role, :create
      update SynieCore.Authz.Role, :update_sys_role, :update
      destroy SynieCore.Authz.Role, :destroy_sys_role, :destroy

      create SynieCore.Authz.UserRole, :create_sys_user_role, :create
      destroy SynieCore.Authz.UserRole, :destroy_sys_user_role, :destroy

      create SynieCore.Authz.RolePermission, :create_sys_role_permission, :create
      destroy SynieCore.Authz.RolePermission, :destroy_sys_role_permission, :destroy

      create SynieCore.Org.Company, :create_sys_company, :create
      update SynieCore.Org.Company, :update_sys_company, :update
      destroy SynieCore.Org.Company, :destroy_sys_company, :destroy

      create SynieCore.Authz.UserCompany, :create_sys_user_company, :create
      destroy SynieCore.Authz.UserCompany, :destroy_sys_user_company, :destroy

      create SynieCore.Base.Unit, :create_sys_unit, :create
      update SynieCore.Base.Unit, :update_sys_unit, :update
      destroy SynieCore.Base.Unit, :destroy_sys_unit, :destroy

      create SynieCore.Base.Currency, :create_sys_currency, :create
      update SynieCore.Base.Currency, :update_sys_currency, :update
      destroy SynieCore.Base.Currency, :destroy_sys_currency, :destroy
    end
  end

  resources do
    resource SynieCore.Resources.Hello
    resource SynieCore.Accounts.User
    resource SynieCore.Authz.Role
    resource SynieCore.Authz.UserRole
    resource SynieCore.Authz.RolePermission
    resource SynieCore.Authz.UserCompany
    resource SynieCore.Org.Company
    resource SynieCore.Base.Unit
    resource SynieCore.Base.Currency
  end
end
