defmodule SynieCore.Sales.Setting do
  @moduledoc """
  销售设置,对应 `sal_setting` 单行表:销售域全局配置(非公司维度)统一加字段进这张表,
  不另建配置表。行由迁移 seed、恒存在——不开放 create/destroy,只有 read/update。
  当前字段:样品订单条目数量上限(样品行建行与订单审核复核同卡)。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    fragments: [SynieCore.Audit.Fragment]

  postgres do
    table "sal_setting"
    repo SynieCore.Repo

    check_constraints do
      check_constraint :sample_item_max_qty, "sample_item_max_qty_positive",
        check: "sample_item_max_qty > 0",
        message: "样品条目数量上限必须大于零"
    end
  end

  graphql do
    type :sal_setting
  end

  policies do
    bypass actor_attribute_equals(:super_admin, true) do
      authorize_if always()
    end

    policy action([:read, :update]) do
      authorize_if SynieCore.Authz.Checks.HasPermission
    end
  end

  def permission_prefix, do: "sales.setting"
  def permission_actions, do: ~w(read update)

  actions do
    read :read do
      primary? true
    end

    update :update do
      accept [:sample_item_max_qty]

      require_atomic? false
    end
  end

  validations do
    validate compare(:sample_item_max_qty, greater_than: 0), message: "样品条目数量上限必须大于零"
  end

  attributes do
    uuid_primary_key :id

    attribute :sample_item_max_qty, :integer do
      allow_nil? false
      default 100
      public? true
      description "样品订单条目数量上限"
    end

    create_timestamp :inserted_at, public?: true, description: "创建时间"
    update_timestamp :updated_at, public?: true, description: "更新时间"
  end

  @doc "取单行配置(受信内部读;迁移 seed 保证存在,nil 仅见于异常环境)。"
  @spec get() :: %__MODULE__{} | nil
  def get do
    __MODULE__ |> Ash.read!(authorize?: false) |> List.first()
  end
end
