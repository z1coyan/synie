defmodule SynieCore.Mfg.Setting do
  @moduledoc """
  生产设置,对应 `mfg_setting` 单行表:生产域全局配置(非公司维度)。
  行由迁移 seed、恒存在——不开放 create/destroy,只有 read/update。
  当前字段:生产入库超入比例(审核时卡累计已入)。
  权限前缀 `mfg.setting`,界面中文名「生产设置」。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    fragments: [SynieCore.Audit.Fragment]

  postgres do
    table "mfg_setting"
    repo SynieCore.Repo

    check_constraints do
      check_constraint :output_overreceive_ratio, "output_overreceive_ratio_range",
        check: "output_overreceive_ratio >= 0 AND output_overreceive_ratio <= 1",
        message: "生产入库超入比例必须在 0(含)与 1(含)之间"
    end
  end

  graphql do
    type :mfg_setting
  end

  policies do
    bypass actor_attribute_equals(:super_admin, true) do
      authorize_if always()
    end

    policy action([:read, :update]) do
      authorize_if SynieCore.Authz.Checks.HasPermission
    end
  end

  def permission_prefix, do: "mfg.setting"
  def permission_label, do: "生产设置"
  def permission_actions, do: ~w(read update)

  actions do
    read :read do
      primary? true
    end

    update :update do
      accept [:output_overreceive_ratio]
      require_atomic? false
    end
  end

  validations do
    validate compare(:output_overreceive_ratio, greater_than_or_equal_to: 0),
      message: "生产入库超入比例不能为负"

    validate compare(:output_overreceive_ratio, less_than_or_equal_to: 1),
      message: "生产入库超入比例不能超过 100%"
  end

  attributes do
    uuid_primary_key :id

    attribute :output_overreceive_ratio, :decimal do
      allow_nil? false
      default Decimal.new(0)
      public? true
      description "生产入库超入比例(小数,0=禁超入,0.05=5%,上限 1)"
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
