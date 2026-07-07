defmodule SynieCore.AuthzTest do
  use ExUnit.Case, async: true

  import SynieCore.AuthzFixtures

  alias SynieCore.Authz
  alias SynieCore.Authz.Actor

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)
  end

  test "build_actor 汇总多角色权限并去重" do
    user = user!()
    role_a = role!()
    role_b = role!()
    grant!(role_a, "sales.order:read")
    grant!(role_a, "sales.order:create")
    grant!(role_b, "sales.order:read")
    assign!(user, role_a)
    assign!(user, role_b)

    actor = Authz.build_actor(user)

    assert actor.permissions == MapSet.new(["sales.order:read", "sales.order:create"])
    assert actor.user_id == user.id
    refute actor.super_admin
  end

  test "禁用角色的权限不生效" do
    user = user!()
    role = role!(%{enabled: false})
    grant!(role, "sales.order:read")
    assign!(user, role)

    actor = Authz.build_actor(user)

    assert MapSet.size(actor.permissions) == 0
  end

  test "无角色用户得到空权限集" do
    actor = Authz.build_actor(user!())

    assert MapSet.size(actor.permissions) == 0
    assert actor.company_ids == []
  end

  test "build_actor 加载授权公司" do
    user = user!()
    co_a = company!()
    co_b = company!()
    grant_company!(user, co_a)
    grant_company!(user, co_b)

    actor = Authz.build_actor(user)

    assert Enum.sort(actor.company_ids) == Enum.sort([co_a.id, co_b.id])
  end

  test "has_permission? 支持通配与超级管理员" do
    assert Authz.has_permission?(%Actor{user_id: "x", super_admin: true}, "anything.at:all")

    actor = %Actor{user_id: "x", permissions: MapSet.new(["sales.*"])}
    assert Authz.has_permission?(actor, "sales.order:audit")
    refute Authz.has_permission?(actor, "fi.voucher:read")

    refute Authz.has_permission?(nil, "sales.order:read")
  end
end
