defmodule SynieCore.Sales.OrderStatus do
  @moduledoc "销售订单状态:草稿/已审核/已关闭/已作废。"

  use Ash.Type.Enum, values: [draft: "草稿", audited: "已审核", closed: "已关闭", voided: "已作废"]

  def graphql_type(_), do: :sal_order_status
end

defmodule SynieCore.Sales.OrderDraft do
  @moduledoc "校验订单处于草稿态(修改/删除的前提)。"

  use Ash.Resource.Validation

  @impl true
  def validate(changeset, _opts, _context) do
    if changeset.data.status == :draft do
      :ok
    else
      {:error, message: "仅草稿订单可修改或删除"}
    end
  end
end

defmodule SynieCore.Sales.OrderPartyType do
  @moduledoc "销售订单对手类型限客户/内部公司(供应商留给将来的采购订单);必填由属性兜底。"

  use Ash.Resource.Validation

  @impl true
  def validate(changeset, _opts, _context) do
    case Ash.Changeset.get_attribute(changeset, :party_type) do
      nil -> :ok
      t when t in [:customer, :company] -> :ok
      _ -> {:error, field: :party_type, message: "对手类型只能为客户或内部公司"}
    end
  end
end

defmodule SynieCore.Sales.Order do
  @moduledoc """
  销售订单(头),对应 `sal_order` 表。公司向客户承诺供货的订货单据,纯业务承诺:
  审核不派生 GL 分录也不动库存,履行(发货/开票)由将来的下游模块承载。

  生命周期:草稿(可改可删)→ 已审核(audit,锁死,无反审核)→ 已关闭(close)/
  已作废(void)两个终态,均不可逆;仅已审核单可关闭/作废(关闭=生效后提前终止,
  作废=单据不该存在)。订单号全局唯一:留空按 `sales.order` 编号规则自动取号
  (AutoNumber),手填原样保留。对手为多态引用(客户/内部公司,无真外键),
  审核唯一业务门槛是行数 ≥ 1。行见 `OrderItem`,删除草稿时行由 DB 级联删除。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    fragments: [SynieCore.Audit.Fragment]

  require Ash.Query

  postgres do
    table "sal_order"
    repo SynieCore.Repo

    check_constraints do
      check_constraint :party_type, "party_pair",
        check: "(party_type IS NULL) = (party_id IS NULL)",
        message: "对手类型与对手必须同时填写"
    end
  end

  graphql do
    type :sal_order
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

  def permission_prefix, do: "sales.order"
  def permission_actions, do: ~w(create read update delete audit close void)

  def grid_actions do
    [
      %{key: "audit", label: "审核", scope: "row", mutation: "auditSalOrder", is_danger: false},
      %{key: "close", label: "关闭", scope: "row", mutation: "closeSalOrder", is_danger: false},
      %{key: "void", label: "作废", scope: "row", mutation: "voidSalOrder", is_danger: true}
    ]
  end

  # 对手是多态引用(party_type 判别、无 belongs_to),声明给 GridMeta 反射成多态 fk 列;
  # 取值限客户/内部公司(见 OrderPartyType)
  def poly_refs do
    %{
      party_id: %{
        discriminator: :party_type,
        variants: Map.take(SynieCore.Acc.PartyType.party_resources(), [:customer, :company])
      }
    }
  end

  actions do
    read :read do
      primary? true

      pagination offset?: true,
                 countable: true,
                 required?: false,
                 default_limit: 20,
                 max_page_size: 200
    end

    create :create do
      accept [:company_id, :order_no, :order_date, :party_type, :party_id, :terms, :remarks]

      validate {SynieCore.Authz.Validations.CompanyAccessible, []}
      validate {SynieCore.Sales.OrderPartyType, []}
      validate {SynieCore.Acc.PartyExists, []}
      validate {SynieCore.Acc.PartyNotSelf, []}

      # 编号留空自动取号(须在构建期,见 AutoNumber moduledoc)
      change {SynieCore.Numbering.AutoNumber, attribute: :order_no}

      # 录入人自动取 actor;nil actor 只出现在受信内部路径,允许留空
      change fn changeset, context ->
        case context.actor do
          %SynieCore.Authz.Actor{user_id: user_id} ->
            Ash.Changeset.force_change_attribute(changeset, :created_by_id, user_id)

          _ ->
            changeset
        end
      end
    end

    update :update do
      accept [:order_no, :order_date, :party_type, :party_id, :terms, :remarks]
      require_atomic? false

      # 构建期预检(用户体验),权威复检在 before_action 钩子内
      validate {SynieCore.Sales.OrderDraft, []}
      validate {SynieCore.Sales.OrderPartyType, []}
      validate {SynieCore.Acc.PartyExists, []}
      validate {SynieCore.Acc.PartyNotSelf, []}

      change fn changeset, _context ->
        Ash.Changeset.before_action(changeset, fn cs ->
          # 权威复检:事务内 FOR UPDATE 重读,关闭"并发审核后头字段被改"竞态
          case __MODULE__.lock_order(cs.data.id) do
            {:ok, %{status: :draft}} -> cs
            _ -> Ash.Changeset.add_error(cs, message: "仅草稿订单可修改或删除")
          end
        end)
      end
    end

    destroy :destroy do
      primary? true
      require_atomic? false

      # 构建期预检(用户体验),权威复检在 before_action 钩子内
      validate {SynieCore.Sales.OrderDraft, []}

      change fn changeset, _context ->
        Ash.Changeset.before_action(changeset, fn cs ->
          # 权威复检:事务内 FOR UPDATE 重读,关闭"并发审核后订单被删、行成孤儿"竞态
          case __MODULE__.lock_order(cs.data.id) do
            {:ok, %{status: :draft}} -> cs
            _ -> Ash.Changeset.add_error(cs, message: "仅草稿订单可修改或删除")
          end
        end)
      end
    end

    update :audit do
      accept []
      require_atomic? false

      # 构建期预检(用户体验,普通读即可):此时在动作事务之外,无需也不能加锁。
      # 权威复检在下方 change 的 before_action 钩子内(事务内 FOR UPDATE 重读)完成。
      validate fn changeset, _context ->
        if changeset.data.status == :draft, do: :ok, else: {:error, message: "仅草稿订单可审核"}
      end

      validate fn changeset, _context ->
        if __MODULE__.has_items?(changeset.data.id) do
          :ok
        else
          {:error, message: "审核前必须至少填写一行条目"}
        end
      end

      change fn changeset, context ->
        changeset
        |> Ash.Changeset.force_change_attribute(:status, :audited)
        |> Ash.Changeset.force_change_attribute(:audited_at, DateTime.utc_now())
        |> then(fn cs ->
          case context.actor do
            %SynieCore.Authz.Actor{user_id: user_id} ->
              Ash.Changeset.force_change_attribute(cs, :audited_by_id, user_id)

            _ ->
              cs
          end
        end)
        |> Ash.Changeset.before_action(fn cs ->
          # 权威复检:before_action 在动作事务内执行,FOR UPDATE 持锁到事务提交,
          # 借此串行化审核与行编辑/并发审核——关闭双审核竞态(构建期预检看到的状态可能已过期)
          case __MODULE__.lock_order(cs.data.id) do
            {:ok, %{status: :draft}} ->
              if __MODULE__.has_items?(cs.data.id) do
                cs
              else
                Ash.Changeset.add_error(cs, message: "审核前必须至少填写一行条目")
              end

            _ ->
              Ash.Changeset.add_error(cs, message: "仅草稿订单可审核")
          end
        end)
      end
    end

    update :close do
      accept []
      require_atomic? false

      # 构建期预检(用户体验),权威复检在 before_action 钩子内
      validate fn changeset, _context ->
        if changeset.data.status == :audited, do: :ok, else: {:error, message: "仅已审核订单可关闭"}
      end

      change fn changeset, _context ->
        changeset
        |> Ash.Changeset.force_change_attribute(:status, :closed)
        |> Ash.Changeset.before_action(fn cs ->
          # 权威复检:事务内 FOR UPDATE 重读,关闭并发竞态(与审核同根因)
          case __MODULE__.lock_order(cs.data.id) do
            {:ok, %{status: :audited}} -> cs
            _ -> Ash.Changeset.add_error(cs, message: "仅已审核订单可关闭")
          end
        end)
      end
    end

    update :void do
      accept []
      require_atomic? false

      # 构建期预检(用户体验),权威复检在 before_action 钩子内
      validate fn changeset, _context ->
        if changeset.data.status == :audited, do: :ok, else: {:error, message: "仅已审核订单可作废"}
      end

      change fn changeset, _context ->
        changeset
        |> Ash.Changeset.force_change_attribute(:status, :voided)
        |> Ash.Changeset.before_action(fn cs ->
          # 权威复检:事务内 FOR UPDATE 重读,关闭并发竞态(与审核同根因)
          case __MODULE__.lock_order(cs.data.id) do
            {:ok, %{status: :audited}} -> cs
            _ -> Ash.Changeset.add_error(cs, message: "仅已审核订单可作废")
          end
        end)
      end
    end
  end

  attributes do
    uuid_primary_key :id

    attribute :order_no, :string do
      allow_nil? false
      public? true
      constraints max_length: 32
      description "订单号"
    end

    attribute :order_date, :date do
      allow_nil? false
      public? true
      default &Date.utc_today/0
      description "订单日期"
    end

    attribute :party_type, SynieCore.Acc.PartyType do
      allow_nil? false
      public? true
      description "对手类型(客户/内部公司)"
    end

    attribute :party_id, :uuid do
      allow_nil? false
      public? true
      description "对手"
    end

    attribute :terms, :string do
      public? true
      description "交易条款(对客户,自由文本)"
    end

    attribute :remarks, :string do
      public? true
      constraints max_length: 512
      description "订单备注(对内)"
    end

    attribute :status, SynieCore.Sales.OrderStatus do
      allow_nil? false
      writable? false
      default :draft
      public? true
      description "状态"
    end

    attribute :audited_at, :utc_datetime_usec do
      writable? false
      public? true
      description "审核时间"
    end

    create_timestamp :inserted_at, public?: true, description: "创建时间"
    update_timestamp :updated_at, public?: true, description: "更新时间"
  end

  relationships do
    belongs_to :company, SynieCore.Base.Company do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "公司"
    end

    belongs_to :created_by, SynieCore.Accounts.User do
      public? true
      attribute_public? true
      description "录入人"
    end

    belongs_to :audited_by, SynieCore.Accounts.User do
      public? true
      attribute_public? true
      description "审核人"
    end

    has_many :items, SynieCore.Sales.OrderItem do
      destination_attribute :order_id
      sort idx: :asc
      public? true
      description "订单条目"
    end
  end

  aggregates do
    sum :gross_total, :items, :amount do
      public? true
      description "含税总额(行含税金额合计)"
    end
  end

  identities do
    identity :unique_order_no, [:order_no], message: "订单号已存在"
  end

  @doc false
  # 订单粒度锁:FOR UPDATE 锁住订单行本身;仅在 before_action 钩子内调用才有效——
  # before_action 在动作事务内执行,锁持有到事务提交,借此串行化行编辑/审核/关闭/作废
  def lock_order(order_id) do
    __MODULE__
    |> Ash.Query.filter(id == ^order_id)
    |> Ash.Query.lock("FOR UPDATE")
    |> Ash.read_one(authorize?: false)
  end

  @doc false
  # 审核门槛:订单至少一行条目
  def has_items?(order_id) do
    SynieCore.Sales.OrderItem
    |> Ash.Query.filter(order_id == ^order_id)
    |> Ash.exists?(authorize?: false)
  end
end
