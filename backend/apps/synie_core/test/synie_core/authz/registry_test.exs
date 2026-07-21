defmodule SynieCore.Authz.RegistryTest do
  use ExUnit.Case, async: true

  alias SynieCore.Authz.{Actor, Registry}

  test "catalog 包含全部声明了权限前缀的资源" do
    prefixes = Registry.catalog() |> Enum.map(& &1.prefix) |> Enum.sort()

    assert prefixes ==
             Enum.sort(
               ~w(sys.user sys.role sys.role_permission sys.audit_log sys.file sys.storage sys.numbering_rule sys.setting base.company base.unit base.currency base.account base.market_instrument base.market_price sales.customer sales.order sales.delivery sales.reconciliation sales.quotation sales.setting purchase.supplier purchase.quotation purchase.order purchase.receipt hr.employee hr.attendance_punch hr.attendance_day hr.attendance_correction hr.payroll hr.payroll_payment hr.employee_loan inv.material_category inv.material inv.warehouse inv.stock_entry inv.stock_doc inv.stock_transfer inv.stock_count acc.gl_entry acc.gl_journal acc.bank_account acc.bank_transaction acc.bank_import_template acc.vat_invoice acc.bill acc.bill_transaction acc.bill_holding acc.setting)
             )
  end

  test "catalog 组带中文资源标签" do
    labels = Map.new(Registry.catalog(), &{&1.prefix, &1.label})

    assert labels["sales.order"] == "销售订单"
    assert labels["sys.role"] == "角色"
    assert labels["acc.gl_journal"] == "会计凭证"
  end

  test "all_codes 展开为 前缀:动作" do
    codes = Registry.all_codes()

    assert "sys.role:create" in codes
    assert "sys.role:delete" in codes
    assert "base.company:update" in codes
    refute "sys.role:import" in codes
  end

  test "granted_codes 将通配展开为具体码" do
    actor = %Actor{user_id: "x", permissions: MapSet.new(["sys.role:*"])}

    assert Enum.sort(Registry.granted_codes(actor)) ==
             Enum.sort(~w(sys.role:create sys.role:read sys.role:update sys.role:delete
                  sys.role:batch_delete sys.role:export sys.role:print sys.role:batch_print))
  end

  test "granted_codes 域通配展开" do
    actor = %Actor{user_id: "x", permissions: MapSet.new(["base.*"])}

    codes = Registry.granted_codes(actor)

    for resource <- ~w(company unit currency account), action <- ~w(create read update delete) do
      assert "base.#{resource}:#{action}" in codes
    end

    refute Enum.any?(codes, &String.starts_with?(&1, "sys."))
  end

  test "super_admin 得到全部权限码" do
    actor = %Actor{user_id: "x", super_admin: true}

    assert Registry.granted_codes(actor) == Registry.all_codes()
  end

  test "granted_codes 全域通配 * 展开为全部" do
    actor = %Actor{user_id: "x", permissions: MapSet.new(["*"])}

    assert Registry.granted_codes(actor) == Registry.all_codes()
  end
end
