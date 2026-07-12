defmodule SynieCore.Files.OwnerRegistryTest do
  use ExUnit.Case, async: true

  alias SynieCore.Files.OwnerRegistry

  test "已知 owner_type 解析到对应资源模块" do
    assert {:ok, SynieCore.Sales.Customer} = OwnerRegistry.resolve("sal_customer")
    assert {:ok, SynieCore.Purchase.Supplier} = OwnerRegistry.resolve("pur_supplier")
    assert {:ok, SynieCore.Acc.GlJournal} = OwnerRegistry.resolve("acc_gl_journal")
  end

  test "未知 owner_type 返回 :error(fail-closed)" do
    assert :error = OwnerRegistry.resolve("nope")
    assert :error = OwnerRegistry.resolve("sys_file")
    assert :error = OwnerRegistry.resolve("")
  end

  test "owner_types 列出白名单键" do
    types = OwnerRegistry.owner_types()
    assert "sal_customer" in types
    assert "pur_supplier" in types
    assert "acc_gl_journal" in types
  end
end
