defmodule SynieCore.Authz.RegistryTest do
  use ExUnit.Case, async: true

  alias SynieCore.Authz.{Actor, Registry}

  test "catalog 包含全部声明了权限前缀的资源" do
    prefixes = Registry.catalog() |> Enum.map(& &1.prefix) |> Enum.sort()

    assert prefixes ==
             Enum.sort(
               ~w(sys.user sys.role sys.role_permission sys.audit_log sys.file sys.storage sys.numbering_rule base.company base.unit base.currency base.account sales.customer sales.order purchase.supplier hr.employee hr.attendance_punch hr.attendance_day hr.attendance_correction hr.payroll hr.payroll_payment hr.employee_loan inv.material_category inv.material acc.gl_entry acc.gl_journal acc.bank_account acc.bank_transaction acc.bank_import_template acc.vat_invoice acc.bill acc.bill_transaction acc.bill_holding acc.setting)
             )
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
end
