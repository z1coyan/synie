defmodule SynieCore.Sales.Setting do
  @moduledoc """
  供应链设置,对应 `sal_setting` 单行表:供应链全局配置(非公司维度)统一加字段进这张表,
  不另建配置表。行由迁移 seed、恒存在——不开放 create/destroy,只有 read/update。
  当前字段:样品订单单行数量上限、零星订单单行数量上限、发货超发比例(发货审核时卡累计已发)、
  入库超收比例(入库审核时卡累计已收,校验属采购入库第二期)。
  权限前缀仍为 sales.setting(历史资源码,界面中文名「供应链设置」)。
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

      check_constraint :delivery_overship_ratio, "delivery_overship_ratio_range",
        check: "delivery_overship_ratio >= 0 AND delivery_overship_ratio <= 1",
        message: "发货超发比例必须在 0(含)与 1(含)之间"

      check_constraint :spot_item_max_qty, "spot_item_max_qty_positive",
        check: "spot_item_max_qty > 0",
        message: "零星条目数量上限必须大于零"

      check_constraint :receipt_overreceive_ratio, "receipt_overreceive_ratio_range",
        check: "receipt_overreceive_ratio >= 0 AND receipt_overreceive_ratio <= 1",
        message: "入库超收比例必须在 0(含)与 1(含)之间"
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
      accept [
        :sample_item_max_qty,
        :delivery_overship_ratio,
        :spot_item_max_qty,
        :receipt_overreceive_ratio
      ]

      require_atomic? false
    end
  end

  validations do
    validate compare(:sample_item_max_qty, greater_than: 0), message: "样品条目数量上限必须大于零"

    validate compare(:delivery_overship_ratio, greater_than_or_equal_to: 0),
      message: "发货超发比例不能为负"

    validate compare(:delivery_overship_ratio, less_than_or_equal_to: 1),
      message: "发货超发比例不能超过 100%"

    validate compare(:spot_item_max_qty, greater_than: 0), message: "零星条目数量上限必须大于零"

    validate compare(:receipt_overreceive_ratio, greater_than_or_equal_to: 0),
      message: "入库超收比例不能为负"

    validate compare(:receipt_overreceive_ratio, less_than_or_equal_to: 1),
      message: "入库超收比例不能超过 100%"
  end

  attributes do
    uuid_primary_key :id

    attribute :sample_item_max_qty, :integer do
      allow_nil? false
      default 100
      public? true
      description "样品订单条目数量上限"
    end

    attribute :delivery_overship_ratio, :decimal do
      allow_nil? false
      default Decimal.new(0)
      public? true
      description "发货超发比例(小数,0=禁超发,0.05=5%,上限 1)"
    end

    attribute :spot_item_max_qty, :integer do
      allow_nil? false
      default 100
      public? true
      description "零星订单条目数量上限"
    end

    attribute :receipt_overreceive_ratio, :decimal do
      allow_nil? false
      default Decimal.new(0)
      public? true
      description "入库超收比例(小数,0=禁超收,0.05=5%,上限 1)"
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
