defmodule SynieCore.Purchase.QuotationTier.SyncItem do
  @moduledoc """
  价格档与父条目/报价单同步:条目必须存在、须为数量梯度模式、其报价单须草稿态
  (增删改档的前提);create 时把条目 company_id 冗余到档(数据权限按公司过滤)。
  构建期预检仅为友好报错;权威复检在 before_action 钩子内:锁的是报价单
  (FOR UPDATE,与条目/审核同一把锁),持锁后重读条目复核模式——条目编辑同样
  持报价单锁,借此关闭「档在写、条目并发切回固定价」的竞态。
  """

  use Ash.Resource.Change

  require Ash.Query

  @impl true
  def change(changeset, _opts, _context) do
    changeset =
      case load_item(changeset_item_id(changeset)) do
        {:ok, %{item: item, quotation: %{status: :draft}}} when not is_nil(item) ->
          cond do
            item.pricing_mode != :qty_tiered ->
              Ash.Changeset.add_error(changeset, field: :item_id, message: "仅数量梯度条目可维护价格档")

            changeset.action_type == :create ->
              Ash.Changeset.force_change_attribute(changeset, :company_id, item.company_id)

            true ->
              changeset
          end

        {:ok, %{item: nil}} ->
          Ash.Changeset.add_error(changeset, field: :item_id, message: "报价条目不存在")

        {:ok, _} ->
          Ash.Changeset.add_error(changeset, field: :item_id, message: "仅草稿报价单可编辑价格档")

        _ ->
          Ash.Changeset.add_error(changeset, field: :item_id, message: "报价条目不存在")
      end

    Ash.Changeset.before_action(changeset, fn cs ->
      with {:ok, %{item: item, quotation: quotation}} when not is_nil(item) <-
             load_item(changeset_item_id(cs)),
           {:ok, %{status: :draft}} <- lock_quotation(quotation.id) do
        # 持报价单锁后复核条目模式(条目切模式同样持此锁,读到的必是定稿)
        case Ash.get(SynieCore.Purchase.QuotationItem, item.id, authorize?: false) do
          {:ok, %{pricing_mode: :qty_tiered}} ->
            cs

          _ ->
            Ash.Changeset.add_error(cs, field: :item_id, message: "仅数量梯度条目可维护价格档")
        end
      else
        {:ok, %{item: nil}} ->
          Ash.Changeset.add_error(cs, field: :item_id, message: "报价条目不存在")

        _ ->
          Ash.Changeset.add_error(cs, field: :item_id, message: "仅草稿报价单可编辑价格档")
      end
    end)
  end

  defp changeset_item_id(changeset),
    do: Ash.Changeset.get_attribute(changeset, :item_id) || changeset.data.item_id

  defp load_item(nil), do: {:ok, %{item: nil}}

  defp load_item(item_id) do
    case SynieCore.Purchase.QuotationItem
         |> Ash.Query.filter(id == ^item_id)
         |> Ash.read_one(authorize?: false) do
      {:ok, nil} ->
        {:ok, %{item: nil}}

      {:ok, item} ->
        case SynieCore.Purchase.Quotation
             |> Ash.Query.filter(id == ^item.quotation_id)
             |> Ash.read_one(authorize?: false) do
          {:ok, %{} = quotation} -> {:ok, %{item: item, quotation: quotation}}
          _ -> {:ok, %{item: nil}}
        end

      error ->
        error
    end
  end

  defp lock_quotation(quotation_id) do
    SynieCore.Purchase.Quotation
    |> Ash.Query.filter(id == ^quotation_id)
    |> Ash.Query.lock("FOR UPDATE")
    |> Ash.read_one(authorize?: false)
  end
end

defmodule SynieCore.Purchase.QuotationTier do
  @moduledoc """
  采购报价价格档,对应 `pur_quotation_tier` 表。数量梯度条目的起量价阶梯:
  每档 =(起订量, 含税档价),订购量 ≥ 起订量即适用该档价,档间上界由下一档隐含,
  低于首档起订量视为无报价。起订量同条目内唯一(即天然严格递增);
  档价不强制随量递减(涨价梯度是合法业务)。

  `company_id` 冗余自父条目以复用公司数据权限;仅父报价单草稿态、且条目为
  数量梯度模式时可增删改;条目删除/切回固定价时档随之清空(DB 级联/
  `ClearTiersOnFixed`)。无独立权限点,动作复用 `purchase.quotation` 权限码。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    fragments: [SynieCore.Audit.Fragment],
    # 主 read 上的兜底排序(起订量升序)是有意为之,阶梯按量呈现依赖此序
    primary_read_warning?: false

  postgres do
    table "pur_quotation_tier"
    repo SynieCore.Repo

    references do
      # 删条目 DB 级联删档(档不留单独审计,条目/报价单的变更本身已审计)
      reference :item, on_delete: :delete
    end

    check_constraints do
      check_constraint :min_qty, "min_qty_positive",
        check: "min_qty > 0",
        message: "起订量必须大于零"

      check_constraint :price, "price_nonnegative",
        check: "price >= 0",
        message: "含税档价不能为负"
    end
  end

  graphql do
    type :pur_quotation_tier
  end

  policies do
    bypass actor_attribute_equals(:super_admin, true) do
      authorize_if always()
    end

    policy always() do
      authorize_if SynieCore.Authz.Checks.HasPermission
    end

    policy action_type([:read, :update, :destroy]) do
      authorize_if SynieCore.Authz.Checks.CompanyScope
    end
  end

  # 复用报价单权限码;actions 为空不进权限目录(同 QuotationItem)
  def permission_prefix, do: "purchase.quotation"
  def permission_actions, do: []

  actions do
    read :read do
      primary? true

      pagination offset?: true,
                 countable: true,
                 required?: false,
                 default_limit: 20,
                 max_page_size: 200

      # 阶梯按起订量升序呈现:仅在请求未指定排序时兜底
      prepare fn query, _context ->
        if Enum.empty?(query.sort) do
          Ash.Query.sort(query, min_qty: :asc)
        else
          query
        end
      end
    end

    create :create do
      accept [:item_id, :min_qty, :price]

      # 顺序敏感:先回填 company_id,再做公司授权校验
      change {SynieCore.Purchase.QuotationTier.SyncItem, []}
      validate {SynieCore.Authz.Validations.CompanyAccessible, []}
    end

    update :update do
      accept [:min_qty, :price]
      require_atomic? false

      change {SynieCore.Purchase.QuotationTier.SyncItem, []}
    end

    destroy :destroy do
      primary? true
      require_atomic? false

      change {SynieCore.Purchase.QuotationTier.SyncItem, []}
    end

    # 内部动作:条目切回固定价时由 ClearTiersOnFixed 在同事务内逐档调用。
    # 不注册 GraphQL、不进权限目录;不挂 SyncItem——调用方已持报价单锁,
    # 且「仅梯度条目可维护档」的守卫对内部清理不适用(此刻条目已是固定价)
    destroy :purge do
      require_atomic? false
    end
  end

  validations do
    validate compare(:min_qty, greater_than: 0), message: "起订量必须大于零"
    validate compare(:price, greater_than_or_equal_to: 0), message: "含税档价不能为负"
  end

  attributes do
    uuid_primary_key :id

    attribute :min_qty, :decimal do
      allow_nil? false
      public? true
      description "起订量(≥ 该量适用本档价)"
    end

    attribute :price, :decimal do
      allow_nil? false
      public? true
      description "含税档价"
    end

    create_timestamp :inserted_at, public?: true, description: "创建时间"
    update_timestamp :updated_at, public?: true, description: "更新时间"
  end

  relationships do
    belongs_to :item, SynieCore.Purchase.QuotationItem do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "报价条目"
    end

    belongs_to :company, SynieCore.Base.Company do
      allow_nil? false
      public? true
      attribute_public? true
      description "公司"
    end
  end

  identities do
    identity :unique_item_min_qty, [:item_id, :min_qty], message: "同一起订量档已存在"
  end
end
