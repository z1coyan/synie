defmodule SynieCore.Authz.PermissionTest do
  use ExUnit.Case, async: true

  alias SynieCore.Authz.Permission

  test "精确匹配" do
    assert Permission.matches?(["sales.order:read"], "sales.order:read")
    refute Permission.matches?(["sales.order:read"], "sales.order:update")
  end

  test "资源通配:前缀:*" do
    assert Permission.matches?(["sales.order:*"], "sales.order:audit")
    refute Permission.matches?(["sales.order:*"], "sales.refund:read")
  end

  test "域通配:域.*" do
    assert Permission.matches?(["sales.*"], "sales.order:batch_delete")
    assert Permission.matches?(["sales.*"], "sales.refund:read")
    refute Permission.matches?(["sales.*"], "fi.voucher:read")
  end

  test "权限集可以是 MapSet" do
    perms = MapSet.new(["sys.role:*"])
    assert Permission.matches?(perms, "sys.role:create")
  end

  test "空权限集与畸形权限码不匹配" do
    refute Permission.matches?([], "sales.order:read")
    refute Permission.matches?(["sales.order:read"], "not-a-code")
  end

  test "无域前缀的权限码只做精确与资源通配匹配" do
    assert Permission.matches?(["hello:read"], "hello:read")
    assert Permission.matches?(["hello:*"], "hello:read")
  end

  test "默认动作集为 10 个" do
    assert Permission.default_actions() == ~w(create delete update read print import export batch_delete batch_update batch_print)
  end
end
