defmodule SynieCore.Repo.Migrations.MarketFetchSettings do
  @moduledoc """
  行情定时拉取配置与运行状态进 sys_setting(总开关、最新价间隔、结算开关、上次结果)。
  """
  use Ecto.Migration

  def up do
    alter table(:sys_setting) do
      add :market_fetch_schedule_enabled, :boolean, null: false, default: true
      add :market_fetch_last_interval_minutes, :integer, null: false, default: 60
      add :market_fetch_settlement_enabled, :boolean, null: false, default: true
      add :market_fetch_last_run_at, :utc_datetime
      add :market_fetch_last_summary, :text
    end

    create constraint(:sys_setting, :market_fetch_last_interval_allowed,
             check: "market_fetch_last_interval_minutes IN (30, 60, 120)"
           )
  end

  def down do
    drop_if_exists constraint(:sys_setting, :market_fetch_last_interval_allowed)

    alter table(:sys_setting) do
      remove :market_fetch_schedule_enabled
      remove :market_fetch_last_interval_minutes
      remove :market_fetch_settlement_enabled
      remove :market_fetch_last_run_at
      remove :market_fetch_last_summary
    end
  end
end
