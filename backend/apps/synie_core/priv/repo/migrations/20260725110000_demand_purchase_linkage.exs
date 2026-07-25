defmodule SynieCore.Repo.Migrations.DemandPurchaseLinkage do
  @moduledoc """
  履约需求与采购/委外串联地基:

  - 需求行投影列 ordered_qty / received_qty(默认单位,默认 0)
  - 采购订单条目可空 demand_line_id / demand_date
  - 供应链设置 demand_overorder_ratio(需求超下单比例,默认 0)
  """

  use Ecto.Migration

  def up do
    alter table(:mfg_demand_item) do
      add :ordered_qty, :decimal, null: false, default: "0"
      add :received_qty, :decimal, null: false, default: "0"
    end

    create constraint(:mfg_demand_item, :ordered_qty_nonnegative,
             check: "ordered_qty >= 0",
             comment: "已下单数量不能为负"
           )

    create constraint(:mfg_demand_item, :received_qty_nonnegative,
             check: "received_qty >= 0",
             comment: "已收数量不能为负"
           )

    alter table(:pur_order_item) do
      add :demand_line_id,
          references(:mfg_demand_item,
            column: :id,
            name: "pur_order_item_demand_line_id_fkey",
            type: :uuid,
            on_delete: :restrict
          )

      add :demand_date, :date
    end

    create index(:pur_order_item, [:demand_line_id],
             name: "pur_order_item_demand_line_id_index"
           )

    alter table(:sal_setting) do
      add :demand_overorder_ratio, :decimal, null: false, default: "0"
    end

    create constraint(:sal_setting, :demand_overorder_ratio_range,
             check: "demand_overorder_ratio >= 0 AND demand_overorder_ratio <= 1",
             comment: "需求超下单比例须在 0(含)与 1(含)之间"
           )
  end

  def down do
    drop_if_exists constraint(:sal_setting, :demand_overorder_ratio_range)

    alter table(:sal_setting) do
      remove :demand_overorder_ratio
    end

    drop_if_exists index(:pur_order_item, [:demand_line_id],
                     name: "pur_order_item_demand_line_id_index"
                   )

    drop_if_exists constraint(:pur_order_item, :pur_order_item_demand_line_id_fkey)

    alter table(:pur_order_item) do
      remove :demand_date
      remove :demand_line_id
    end

    drop_if_exists constraint(:mfg_demand_item, :received_qty_nonnegative)
    drop_if_exists constraint(:mfg_demand_item, :ordered_qty_nonnegative)

    alter table(:mfg_demand_item) do
      remove :received_qty
      remove :ordered_qty
    end
  end
end
