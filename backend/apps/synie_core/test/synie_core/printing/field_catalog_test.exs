defmodule SynieCore.Printing.FieldCatalogTest do
  use ExUnit.Case, async: true

  alias SynieCore.Printing.FieldCatalog

  describe "resources/0" do
    test "返回权限目录全部资源码（不再只有 v1 两个）" do
      resources = FieldCatalog.resources()
      assert "sales.order" in resources
      assert "sales.delivery" in resources
      assert "inv.material" in resources
      assert "sys.print_template" in resources
    end
  end

  describe "get/1 派生" do
    test "头字段含标量、计算字段/聚合、belongs_to 一层路径与 party.name" do
      %{fields: fields} = FieldCatalog.get("sales.order")
      names = Enum.map(fields, & &1.name)

      assert "order_no" in names
      assert "status" in names
      assert "gross_total" in names
      assert "company.name" in names
      assert "company.code" in names
      assert "party.name" in names
    end

    test "技术列不进清单：主键、外键、时间戳" do
      %{fields: fields} = FieldCatalog.get("sales.order")
      names = Enum.map(fields, & &1.name)

      refute "id" in names
      refute "company_id" in names
      refute "party_id" in names
      refute "inserted_at" in names
      refute "updated_at" in names
      # 旧拍平键不再存在
      refute "company_name" in names
    end

    test "标签即路径名本身" do
      %{fields: fields} = FieldCatalog.get("sales.order")
      assert Enum.all?(fields, fn %{name: n, label: l} -> n == l end)
    end

    test "循环区按 has_many 派生，条目字段同规则（含关联路径、排除外键）" do
      %{loops: loops} = FieldCatalog.get("sales.order")
      assert [%{name: "items", fields: item_fields} | _] = loops

      names = Enum.map(item_fields, & &1.name)
      assert "material_name" in names
      assert "qty" in names
      assert "material.name" in names
      refute "order_id" in names
    end

    test "无 has_many 的资源 loops 为空" do
      %{loops: loops} = FieldCatalog.get("sys.print_template")
      assert loops == []
    end

    test "未知资源返回 nil" do
      assert FieldCatalog.get("unknown.res") == nil
    end
  end

  describe "validate_placeholders/3" do
    test "路径、party、循环区与 _seq 合法" do
      assert :ok =
               FieldCatalog.validate_placeholders(
                 "sales.order",
                 ["order_no", "status"],
                 %{
                   "company" => ["name"],
                   "party" => ["name"],
                   "items" => ["material_name", "_seq"]
                 }
               )
    end

    test "旧拍平键被拒并点名" do
      assert {:error, msg} =
               FieldCatalog.validate_placeholders("sales.order", ["company_name"], %{})

      assert msg =~ "company_name"
    end

    test "技术列占位符被拒并点名" do
      assert {:error, msg} =
               FieldCatalog.validate_placeholders("sales.order", ["company_id"], %{})

      assert msg =~ "company_id"
    end

    test "二层下钻被拒并点名" do
      assert {:error, msg} =
               FieldCatalog.validate_placeholders(
                 "sales.order",
                 [],
                 %{"company" => ["base_currency.code"]}
               )

      assert msg =~ "company.base_currency.code"
    end

    test "嵌套循环被拒并点名（报价条目内套价格档）" do
      assert {:error, msg} =
               FieldCatalog.validate_placeholders(
                 "sales.quotation",
                 [],
                 %{"items" => ["tiers.price"]}
               )

      assert msg =~ "items.tiers"
    end

    test "同一模板允许多个循环区（顺序各占一段）" do
      assert :ok =
               FieldCatalog.validate_placeholders(
                 "mfg.bom",
                 [],
                 %{"components" => ["_seq"], "routes" => ["_seq"], "byproducts" => ["quantity"]}
               )
    end

    test "未知明细字段点名带循环前缀" do
      assert {:error, msg} =
               FieldCatalog.validate_placeholders(
                 "sales.order",
                 [],
                 %{"items" => ["nope"]}
               )

      assert msg =~ "items.nope"
    end

    test "未知资源报错" do
      assert {:error, _} = FieldCatalog.validate_placeholders("unknown.res", [], %{})
    end
  end
end
