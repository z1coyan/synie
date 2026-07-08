defmodule SynieCore.Org.CompanyTest do
  use ExUnit.Case, async: true

  import SynieCore.AuthzFixtures

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)
  end

  test "创建公司树" do
    group = company!(%{code: "group", name: "集团"})
    sub = company!(%{code: "sub_a", name: "子公司A", parent_id: group.id})

    assert sub.parent_id == group.id
    assert is_nil(group.parent_id)
  end

  test "公司 code 唯一" do
    company!(%{code: "dup_co"})

    assert_raise Ash.Error.Invalid, fn ->
      company!(%{code: "dup_co"})
    end
  end

  test "用户授权公司,不能重复授权" do
    user = user!()
    company = company!()
    grant_company!(user, company)

    assert_raise Ash.Error.Invalid, fn ->
      grant_company!(user, company)
    end
  end

  test "资源声明了权限前缀" do
    assert SynieCore.Org.Company.permission_prefix() == "org.company"
    assert SynieCore.Authz.UserCompany.permission_prefix() == "sys.user_company"
  end
end
