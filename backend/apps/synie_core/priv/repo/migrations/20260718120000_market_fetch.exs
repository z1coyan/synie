defmodule SynieCore.Repo.Migrations.MarketFetch do
  @moduledoc """
  行情品种增加拉取映射字段;种子上期所铜铝银默认启用拉取。
  """
  use Ecto.Migration

  def up do
    alter table(:bas_market_instrument) do
      add :fetch_enabled, :boolean, null: false, default: false
      add :external_last_code, :text
      add :external_product_group, :text
    end

    execute("""
    UPDATE bas_market_instrument SET
      fetch_enabled = true,
      external_last_code = v.last_code,
      external_product_group = v.product_group
    FROM (VALUES
      ('SHFE_CU', 'CU0', 'cu'),
      ('SHFE_AL', 'AL0', 'al'),
      ('SHFE_AG', 'AG0', 'ag')
    ) AS v(code, last_code, product_group)
    WHERE bas_market_instrument.code = v.code
    """)
  end

  def down do
    alter table(:bas_market_instrument) do
      remove :fetch_enabled
      remove :external_last_code
      remove :external_product_group
    end
  end
end
