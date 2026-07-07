defmodule SynieCore do
  use Ash.Domain,
    extensions: [AshGraphql.Domain]

  graphql do
  end

  resources do
    resource SynieCore.Resources.Hello
    resource SynieCore.Accounts.User
    resource SynieCore.Authz.Role
    resource SynieCore.Authz.UserRole
    resource SynieCore.Authz.RolePermission
    resource SynieCore.Authz.UserCompany
    resource SynieCore.Org.Company
  end
end
