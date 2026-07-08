defmodule SynieCore.Org.CompanyTest do
  use ExUnit.Case, async: true

  import SynieCore.AuthzFixtures

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)
  end

  test "创建公司树" do
    group = company!(%{code: "gr", name: "集团", short_name: "集团"})
    sub = company!(%{code: "sa", name: "子公司A", short_name: "子A", parent_id: group.id})

    assert sub.parent_id == group.id
    assert sub.short_name == "子A"
    assert is_nil(group.parent_id)
  end

  test "公司 code 唯一" do
    company!(%{code: "dp"})

    assert_raise Ash.Error.Invalid, fn ->
      company!(%{code: "dp"})
    end
  end

  test "公司 code 必须两位英文字母" do
    for bad <- ["abc", "a", "a1", "中文"] do
      assert_raise Ash.Error.Invalid, fn ->
        company!(%{code: bad})
      end
    end
  end

  test "公司简称必填" do
    assert_raise Ash.Error.Invalid, fn ->
      company!(%{short_name: nil})
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
