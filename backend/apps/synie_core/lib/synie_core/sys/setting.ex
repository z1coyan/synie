defmodule SynieCore.Sys.Setting do
  @moduledoc """
  系统设置,对应 `sys_setting` 单行表:系统级全局配置(非公司维度)统一加字段进这张表,
  不另建配置表(同 acc_setting/sal_setting 先例)。行由迁移 seed、恒存在——不开放
  create/destroy,只有 read/update。

  字段:
  - `setup_completed_at`:初始化完成时刻(仅 Setup 内部写,GraphQL 不暴露修改)
  - 行情拉取:定时总开关、最新价间隔(30/60/120 分)、结算自动补拉、上次运行摘要
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    fragments: [SynieCore.Audit.Fragment]

  postgres do
    table "sys_setting"
    repo SynieCore.Repo

    check_constraints do
      check_constraint :market_fetch_last_interval_minutes,
                       "market_fetch_last_interval_allowed",
                       check: "market_fetch_last_interval_minutes IN (30, 60, 120)",
                       message: "最新价拉取间隔仅允许 30/60/120 分钟"
    end
  end

  graphql do
    type :sys_setting
  end

  policies do
    bypass actor_attribute_equals(:super_admin, true) do
      authorize_if always()
    end

    policy action([:read, :update]) do
      authorize_if SynieCore.Authz.Checks.HasPermission
    end
  end

  def permission_prefix, do: "sys.setting"
  def permission_actions, do: ~w(read update)

  actions do
    read :read do
      primary? true
    end

    update :update do
      # 初始化旗标不经 GraphQL 改;运行摘要由 MarketFetch 内部写入
      accept [
        :market_fetch_schedule_enabled,
        :market_fetch_last_interval_minutes,
        :market_fetch_settlement_enabled
      ]

      require_atomic? false
    end

    # 内部:调度/手动刷新后回写运行状态(不经权限,受信路径)
    update :record_market_fetch do
      accept [:market_fetch_last_run_at, :market_fetch_last_summary]
      require_atomic? false
    end
  end

  validations do
    validate fn changeset, _context ->
      case Ash.Changeset.get_attribute(changeset, :market_fetch_last_interval_minutes) do
        n when n in [30, 60, 120] ->
          :ok

        nil ->
          :ok

        _ ->
          {:error, field: :market_fetch_last_interval_minutes, message: "仅允许 30、60 或 120 分钟"}
      end
    end
  end

  attributes do
    uuid_primary_key :id

    attribute :setup_completed_at, :utc_datetime_usec do
      # 不进 GraphQL 公共写;读仍可给超管排查
      public? false
      description "初始化完成时刻"
    end

    attribute :market_fetch_schedule_enabled, :boolean do
      allow_nil? false
      public? true
      default true
      description "启用行情定时拉取"
    end

    attribute :market_fetch_last_interval_minutes, :integer do
      allow_nil? false
      public? true
      default 60
      description "最新价拉取间隔(分钟,30/60/120)"
    end

    attribute :market_fetch_settlement_enabled, :boolean do
      allow_nil? false
      public? true
      default true
      description "启用日终结算自动补拉"
    end

    attribute :market_fetch_last_run_at, :utc_datetime do
      public? true
      description "上次行情拉取完成时刻"
    end

    attribute :market_fetch_last_summary, :string do
      public? true
      constraints max_length: 500
      description "上次行情拉取结果摘要"
    end

    create_timestamp :inserted_at, public?: true, description: "创建时间"
    update_timestamp :updated_at, public?: true, description: "更新时间"
  end

  @doc "取单行配置(受信内部读;迁移 seed 保证存在,nil 仅见于异常环境)。"
  @spec get() :: %__MODULE__{} | nil
  def get do
    __MODULE__ |> Ash.read!(authorize?: false) |> List.first()
  end

  @doc "行情拉取配置默认值(无行时兜底)。"
  @spec market_fetch_config() :: map()
  def market_fetch_config do
    case get() do
      %__MODULE__{} = s ->
        %{
          schedule_enabled: s.market_fetch_schedule_enabled,
          last_interval_minutes: s.market_fetch_last_interval_minutes,
          settlement_enabled: s.market_fetch_settlement_enabled,
          last_run_at: s.market_fetch_last_run_at,
          last_summary: s.market_fetch_last_summary
        }

      nil ->
        %{
          schedule_enabled: true,
          last_interval_minutes: 60,
          settlement_enabled: true,
          last_run_at: nil,
          last_summary: nil
        }
    end
  end

  @doc "回写上次拉取摘要(调度/手动刷新共用)。"
  @spec record_market_fetch!(String.t()) :: :ok
  def record_market_fetch!(summary) when is_binary(summary) do
    case get() do
      nil ->
        :ok

      setting ->
        summary = String.slice(summary, 0, 500)
        now = DateTime.utc_now() |> DateTime.truncate(:second)

        setting
        |> Ash.Changeset.for_update(:record_market_fetch, %{
          market_fetch_last_run_at: now,
          market_fetch_last_summary: summary
        })
        |> Ash.update!(authorize?: false)

        :ok
    end
  end
end
