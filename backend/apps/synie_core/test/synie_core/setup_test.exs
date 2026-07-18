defmodule SynieCore.SetupTest do
  use ExUnit.Case, async: true

  alias SynieCore.{Authz, Setup}
  alias SynieCore.Accounts.User
  alias SynieCore.Base.Currency

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)
  end

  test "初始状态:未初始化、无用户(测试库迁移种子的完成旗标留空)" do
    assert %{initialized: false, has_users: false} = Setup.status()
  end

  test "create_first_user 建首个用户并打超管旗标,之后拒绝再建" do
    assert {:ok, user} =
             Setup.create_first_user(%{username: "first_admin", name: "管理员", password: "s3cret"})

    assert user.super_admin
    assert %{initialized: false, has_users: true} = Setup.status()

    assert {:error, "已存在用户,请直接登录"} =
             Setup.create_first_user(%{username: "second", password: "x"})
  end

  test "seed_common_currencies 幂等补齐常用货币,已初始化后拒绝" do
    # 迁移已保底 CNY,故新建 19 种、总量 20 种齐全
    assert {:ok, 19} = Setup.seed_common_currencies()

    codes = Currency |> Ash.read!(authorize?: false) |> Enum.map(& &1.iso_code)

    for code <-
          ~w(CNY USD EUR JPY HKD TWD GBP KRW SGD AUD CAD CHF MOP THB MYR IDR VND PHP INR RUB) do
      assert code in codes
    end

    assert {:ok, 0} = Setup.seed_common_currencies()

    {:ok, user} = Setup.create_first_user(%{username: "admin_for_seed", password: "s3cret"})
    :ok = Setup.complete(Authz.build_actor(user), "zh-CN")

    assert {:error, "系统已完成初始化"} = Setup.seed_common_currencies()
  end

  test "complete 写首选语言并落完成旗标,随后 setup 接口全面关闭" do
    {:ok, user} = Setup.create_first_user(%{username: "admin_done", password: "s3cret"})
    actor = Authz.build_actor(user)

    assert {:error, "不支持的语言"} = Setup.complete(actor, "fr-FR")
    assert %{initialized: false} = Setup.status()

    assert :ok = Setup.complete(actor, "zh-CN")

    user = Ash.get!(User, user.id, authorize?: false)
    assert user.preferred_language == "zh-CN"
    assert %{initialized: true} = Setup.status()

    assert {:error, "系统已完成初始化"} = Setup.complete(actor, "en-US")

    assert {:error, "系统已完成初始化"} =
             Setup.create_first_user(%{username: "latecomer", password: "x"})
  end
end
