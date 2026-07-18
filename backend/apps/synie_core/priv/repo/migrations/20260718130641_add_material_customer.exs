defmodule SynieCore.Repo.Migrations.AddMaterialCustomer do
  @moduledoc """
  物料客户约束:is_customer_material + customer_id,及互斥 check。
  """

  use Ecto.Migration

  def up do
    alter table(:inv_material) do
      add :is_customer_material, :boolean, null: false, default: false

      add :customer_id,
          references(:sal_customers,
            column: :id,
            name: "inv_material_customer_id_fkey",
            type: :uuid,
            prefix: "public"
          )
    end

    create constraint(:inv_material, :customer_material_pair,
             check: """
             (is_customer_material = false AND customer_id IS NULL) OR
             (is_customer_material = true AND customer_id IS NOT NULL)
             """
           )
  end

  def down do
    drop_if_exists constraint(:inv_material, :customer_material_pair)

    drop constraint(:inv_material, "inv_material_customer_id_fkey")

    alter table(:inv_material) do
      remove :customer_id
      remove :is_customer_material
    end
  end
end
