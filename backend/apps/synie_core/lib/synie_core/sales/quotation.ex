defmodule SynieCore.Sales.QuotationStatus do
  @moduledoc """
  销售报价单状态:草稿/已审核/已作废。无「已关闭」——报价到截止日天然失效,
  不存在「生效后提前终止履行」的概念;「已过期」是派生展示态(截止日 < 今天 且已审核),
  不落库、不跑定时任务翻状态。
  """

  use Ash.Type.Enum, values: [draft: "草稿", audited: "已审核", voided: "已作废"]

  def graphql_type(_), do: :sal_quotation_status
end

defmodule SynieCore.Sales.QuotationDraft do
  @moduledoc "校验报价单处于草稿态(修改/删除的前提)。"

  use Ash.Resource.Validation

  @impl true
  def validate(changeset, _opts, _context) do
    if changeset.data.status == :draft do
      :ok
    else
      {:error, message: "仅草稿报价单可修改或删除"}
    end
  end
end

defmodule SynieCore.Sales.QuotationPartyType do
  @moduledoc "报价对手类型限客户/内部公司(同销售订单,供应商留给将来的采购侧);必填由属性兜底。"

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

defmodule SynieCore.Sales.Quotation.HeadFieldsFrozen do
  @moduledoc """
  头关键字段变更闸:报价已有条目时,对手/公司/币种不可再改——
  条目物料的客户约束锚定对手,改头会让既有行口径漂移,报错引导先删条目再改头。
  仅挂 update。
  """

  use Ash.Resource.Validation

  @fields [:party_type, :party_id, :company_id, :currency_id]

  @impl true
  def validate(changeset, _opts, _context) do
    if head_changed?(changeset) and SynieCore.Sales.Quotation.has_items?(changeset.data.id) do
      {:error, message: "请先删除报价条目"}
    else
      :ok
    end
  end

  defp head_changed?(changeset) do
    Enum.any?(@fields, fn field ->
      Ash.Changeset.get_attribute(changeset, field) != Map.get(changeset.data, field)
    end)
  end
end

defmodule SynieCore.Sales.Quotation.DefaultCurrency do
  @moduledoc """
  报价单币种归一:币种留空默认单据公司本币。报价单没有金额(条目只有单价、无数量),
  因此不挂汇率、不做双币换算——将来报价转订单时汇率按当时行情填到订单头
  (ADR 2026-07-17-sales-quotation)。公司读不到时跳过,由 CompanyAccessible
  校验/外键兜底报错。
  """

  use Ash.Resource.Change

  @impl true
  def change(changeset, _opts, _context) do
    if Ash.Changeset.get_attribute(changeset, :currency_id) do
      changeset
    else
      company_id =
        Ash.Changeset.get_attribute(changeset, :company_id) || changeset.data.company_id

      case base_currency_id(company_id) do
        nil -> changeset
        id -> Ash.Changeset.force_change_attribute(changeset, :currency_id, id)
      end
    end
  end

  defp base_currency_id(nil), do: nil

  defp base_currency_id(company_id) do
    case Ash.get(SynieCore.Base.Company, company_id, authorize?: false) do
      {:ok, %{base_currency_id: id}} -> id
      _ -> nil
    end
  end
end

defmodule SynieCore.Sales.Quotation do
  @moduledoc """
  销售报价单(头),对应 `sal_quotation` 表。公司向客户/内部公司承诺价格的单据:
  纯价格承诺清单——条目只有单价没有数量,不构成数量/供货承诺(那是销售订单的事),
  也不派生 GL 分录、不动库存。

  生命周期:草稿(可改可删)→ 已审核(audit,锁死,无反审核)→ 已作废(void,
  承担录错与提前撤回两种场景;过期后仍可作废)。无「已关闭」;「已过期」是派生展示态:
  状态=已审核 且 当前日期 > 报价截止(截止当日仍有效),不落库不跑定时任务。
  报价延期不放开改截止日的口子——延期是一次新的报价决策,复制重报一张新单。

  报价单号全局唯一:留空按 `sales.quotation` 编号规则自动取号(AutoNumber),
  手填原样保留。对手为多态引用(客户/内部公司,无真外键)。币种挂头一单一币,
  默认公司本币;无汇率无双币(见 `DefaultCurrency`)。审核门槛:行数 ≥ 1,
  且每个数量梯度条目至少一个价格档。行见 `QuotationItem`,删除草稿时行与
  价格档由 DB 级联删除(行无附件挂接,无需显式清理)。
  ADR 2026-07-17-sales-quotation。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    fragments: [SynieCore.Audit.Fragment]

  require Ash.Query

  postgres do
    table "sal_quotation"
    repo SynieCore.Repo

    check_constraints do
      check_constraint :party_type, "party_pair",
        check: "(party_type IS NULL) = (party_id IS NULL)",
        message: "对手类型与对手必须同时填写"
    end
  end

  graphql do
    type :sal_quotation
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

  def permission_prefix, do: "sales.quotation"
  def permission_label, do: "销售报价单"
  def permission_actions, do: ~w(create read update delete audit void)

  def grid_actions do
    [
      %{key: "audit", label: "审核", scope: "row", mutation: "auditSalQuotation", is_danger: false},
      %{key: "void", label: "作废", scope: "row", mutation: "voidSalQuotation", is_danger: true}
    ]
  end

  # fk 标签用报价单号(默认约定取 :name,本资源没有)
  def display_field, do: :quotation_no

  # 对手是多态引用(party_type 判别、无 belongs_to),声明给 GridMeta 反射成多态 fk 列;
  # 取值限客户/内部公司(见 QuotationPartyType),与销售订单同一套 variants
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
      accept [
        :company_id,
        :quotation_no,
        :quotation_date,
        :valid_until,
        :party_type,
        :party_id,
        :currency_id,
        :terms,
        :remarks
      ]

      validate {SynieCore.Authz.Validations.CompanyAccessible, []}
      validate {SynieCore.Sales.QuotationPartyType, []}
      validate {SynieCore.Acc.PartyExists, []}
      validate {SynieCore.Acc.PartyNotSelf, []}

      # 币种默认公司本币(无汇率,报价单不做双币)
      change {SynieCore.Sales.Quotation.DefaultCurrency, []}

      # 编号留空自动取号(须在构建期,见 AutoNumber moduledoc)
      change {SynieCore.Numbering.AutoNumber, attribute: :quotation_no}

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
      accept [
        :quotation_no,
        :quotation_date,
        :valid_until,
        :party_type,
        :party_id,
        :currency_id,
        :terms,
        :remarks
      ]

      require_atomic? false

      # 构建期预检(用户体验),权威复检在 before_action 钩子内
      validate {SynieCore.Sales.QuotationDraft, []}
      validate {SynieCore.Sales.Quotation.HeadFieldsFrozen, []}
      validate {SynieCore.Sales.QuotationPartyType, []}
      validate {SynieCore.Acc.PartyExists, []}
      validate {SynieCore.Acc.PartyNotSelf, []}

      change {SynieCore.Sales.Quotation.DefaultCurrency, []}

      change fn changeset, _context ->
        Ash.Changeset.before_action(changeset, fn cs ->
          # 权威复检:事务内 FOR UPDATE 重读,关闭"并发审核后头字段被改"竞态
          case __MODULE__.lock_quotation(cs.data.id) do
            {:ok, %{status: :draft}} -> cs
            _ -> Ash.Changeset.add_error(cs, message: "仅草稿报价单可修改或删除")
          end
        end)
      end
    end

    destroy :destroy do
      primary? true
      require_atomic? false

      # 构建期预检(用户体验),权威复检在 before_action 钩子内
      validate {SynieCore.Sales.QuotationDraft, []}

      change fn changeset, _context ->
        Ash.Changeset.before_action(changeset, fn cs ->
          # 权威复检:事务内 FOR UPDATE 重读,关闭"并发审核后单被删、行成孤儿"竞态。
          # 行与价格档走 DB 级联删除,行无附件挂接,无需显式清理
          case __MODULE__.lock_quotation(cs.data.id) do
            {:ok, %{status: :draft}} -> cs
            _ -> Ash.Changeset.add_error(cs, message: "仅草稿报价单可修改或删除")
          end
        end)
      end
    end

    update :audit do
      accept []
      require_atomic? false

      # 构建期预检(用户体验,普通读即可);权威复检在下方 change 的 before_action 钩子内
      validate fn changeset, _context ->
        if changeset.data.status == :draft, do: :ok, else: {:error, message: "仅草稿报价单可审核"}
      end

      validate fn changeset, _context ->
        if __MODULE__.has_items?(changeset.data.id) do
          :ok
        else
          {:error, message: "审核前必须至少填写一行条目"}
        end
      end

      validate fn changeset, _context ->
        if __MODULE__.qty_tiered_without_tiers?(changeset.data.id) do
          {:error, message: "数量梯度条目必须至少填写一个价格档"}
        else
          :ok
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
          # 借此串行化审核与行/档编辑、并发审核(同销售订单先例)
          case __MODULE__.lock_quotation(cs.data.id) do
            {:ok, %{status: :draft}} ->
              cond do
                not __MODULE__.has_items?(cs.data.id) ->
                  Ash.Changeset.add_error(cs, message: "审核前必须至少填写一行条目")

                __MODULE__.qty_tiered_without_tiers?(cs.data.id) ->
                  Ash.Changeset.add_error(cs, message: "数量梯度条目必须至少填写一个价格档")

                true ->
                  cs
              end

            _ ->
              Ash.Changeset.add_error(cs, message: "仅草稿报价单可审核")
          end
        end)
      end
    end

    update :void do
      accept []
      require_atomic? false

      # 作废承担录错+提前撤回两种场景;已过期(派生态)仍是已审核,照常可作废
      validate fn changeset, _context ->
        if changeset.data.status == :audited, do: :ok, else: {:error, message: "仅已审核报价单可作废"}
      end

      change fn changeset, _context ->
        changeset
        |> Ash.Changeset.force_change_attribute(:status, :voided)
        |> Ash.Changeset.before_action(fn cs ->
          # 权威复检:事务内 FOR UPDATE 重读,关闭并发竞态(与审核同根因)
          case __MODULE__.lock_quotation(cs.data.id) do
            {:ok, %{status: :audited}} -> cs
            _ -> Ash.Changeset.add_error(cs, message: "仅已审核报价单可作废")
          end
        end)
      end
    end
  end

  validations do
    # 截止当日仍有效(≤ 截止日),只拦「截止早于报价日期」的倒挂
    validate fn changeset, _context ->
      quotation_date = Ash.Changeset.get_attribute(changeset, :quotation_date)
      valid_until = Ash.Changeset.get_attribute(changeset, :valid_until)

      if is_nil(quotation_date) or is_nil(valid_until) or
           Date.compare(valid_until, quotation_date) != :lt do
        :ok
      else
        {:error, field: :valid_until, message: "报价截止不得早于报价日期"}
      end
    end
  end

  attributes do
    uuid_primary_key :id

    attribute :quotation_no, :string do
      allow_nil? false
      public? true
      constraints max_length: 32
      description "报价单号"
    end

    attribute :quotation_date, :date do
      allow_nil? false
      public? true
      default &Date.utc_today/0
      description "报价日期"
    end

    attribute :valid_until, :date do
      allow_nil? false
      public? true
      description "报价截止(含当日)"
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
      description "报价条款(对客户,自由文本)"
    end

    attribute :remarks, :string do
      public? true
      constraints max_length: 512
      description "报价备注(对内)"
    end

    attribute :status, SynieCore.Sales.QuotationStatus do
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

    # 一单一币:条目单价与全部价格档均以此币种计;留空由 DefaultCurrency 默认公司本币
    belongs_to :currency, SynieCore.Base.Currency do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "币种"
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

    has_many :items, SynieCore.Sales.QuotationItem do
      destination_attribute :quotation_id
      sort idx: :asc
      public? true
      description "报价条目"
    end
  end

  identities do
    identity :unique_quotation_no, [:quotation_no], message: "报价单号已存在"
  end

  @doc false
  # 单据粒度锁:FOR UPDATE 锁住报价单行本身;仅在 before_action 钩子内调用才有效——
  # before_action 在动作事务内执行,锁持有到事务提交,借此串行化行/档编辑与审核/作废
  def lock_quotation(quotation_id) do
    __MODULE__
    |> Ash.Query.filter(id == ^quotation_id)
    |> Ash.Query.lock("FOR UPDATE")
    |> Ash.read_one(authorize?: false)
  end

  @doc false
  # 审核门槛之一:报价单至少一行条目
  def has_items?(quotation_id) do
    SynieCore.Sales.QuotationItem
    |> Ash.Query.filter(quotation_id == ^quotation_id)
    |> Ash.exists?(authorize?: false)
  end

  @doc false
  # 审核门槛之二:数量梯度条目必须至少一个价格档。梯度条目数受单据规模约束,
  # 逐条 exists 探查(审核低频路径,朴素查询换取零表达式风险)
  def qty_tiered_without_tiers?(quotation_id) do
    SynieCore.Sales.QuotationItem
    |> Ash.Query.filter(quotation_id == ^quotation_id and pricing_mode == :qty_tiered)
    |> Ash.read!(authorize?: false)
    |> Enum.any?(fn item ->
      not (SynieCore.Sales.QuotationTier
           |> Ash.Query.filter(item_id == ^item.id)
           |> Ash.exists?(authorize?: false))
    end)
  end
end
