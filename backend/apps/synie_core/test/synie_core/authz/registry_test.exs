defmodule SynieCore.Authz.RegistryTest do
  use ExUnit.Case, async: true

  alias SynieCore.Authz.{Actor, Registry}

  test "catalog 包含全部声明了权限前缀的资源" do
    prefixes = Registry.catalog() |> Enum.map(& &1.prefix) |> Enum.sort()

    assert prefixes ==
             Enum.sort(
               ~w(sys.role sys.user_role sys.role_permission sys.user_company sys.audit_log org.company base.unit base.currency)
             )
  end

  test "all_codes 展开为 前缀:动作" do
    codes = Registry.all_codes()

    assert "sys.role:create" in codes
    assert "sys.role:delete" in codes
    assert "org.company:update" in codes
    refute "sys.role:import" in codes
  end

  test "granted_codes 将通配展开为具体码" do
    actor = %Actor{user_id: "x", permissions: MapSet.new(["sys.role:*"])}

    assert Enum.sort(Registry.granted_codes(actor)) ==
             Enum.sort(~w(sys.role:create sys.role:read sys.role:update sys.role:delete
                  sys.role:batch_delete sys.role:export sys.role:print sys.role:batch_print))
  end

  test "granted_codes 域通配展开" do
    actor = %Actor{user_id: "x", permissions: MapSet.new(["org.*"])}

    assert Enum.sort(Registry.granted_codes(actor)) ==
             Enum.sort(
               ~w(org.company:create org.company:read org.company:update org.company:delete)
             )
  end

  test "super_admin 得到全部权限码" do
    actor = %Actor{user_id: "x", super_admin: true}

    assert Registry.granted_codes(actor) == Registry.all_codes()
  end
end
