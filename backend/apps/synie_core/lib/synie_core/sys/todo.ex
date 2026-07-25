defmodule SynieCore.Sys.TodoType do
  @moduledoc "待办类型:开票(销项)/收票(进项)。"

  use Ash.Type.Enum, values: [issue_invoice: "开票", receive_invoice: "收票"]

  def graphql_type(_), do: :sys_todo_type
end

defmodule SynieCore.Sys.TodoStatus do
  @moduledoc "待办状态:活跃/已关闭。"

  use Ash.Type.Enum, values: [active: "活跃", closed: "已关闭"]

  def graphql_type(_), do: :sys_todo_status
end

defmodule SynieCore.Sys.TodoClosedReason do
  @moduledoc "待办关闭触发来源:撤回确认/发票审核结单。"

  use Ash.Type.Enum, values: [unconfirm: "撤回确认", invoice_audit: "发票审核结单"]

  def graphql_type(_), do: :sys_todo_closed_reason
end

defmodule SynieCore.Sys.Todo.DraftInvoiceLinked do
  @moduledoc "派生:源对账单是否存在草稿态关联发票(「草稿关联中」徽标,不落库)。"

  use Ash.Resource.Calculation

  @impl true
  def load(_query, _opts, _context), do: []

  @impl true
  def calculate(records, _opts, _context) do
    {sal_ids, pur_ids} =
      Enum.reduce(records, {MapSet.new(), MapSet.new()}, fn todo, {sal, pur} ->
        case todo.source_type do
          "sales.reconciliation" -> {MapSet.put(sal, todo.source_id), pur}
          "purchase.reconciliation" -> {sal, MapSet.put(pur, todo.source_id)}
          _ -> {sal, pur}
        end
      end)

    sal_draft = draft_sal_ids(MapSet.to_list(sal_ids))
    pur_draft = draft_pur_ids(MapSet.to_list(pur_ids))

    Enum.map(records, fn todo ->
      case todo.source_type do
        "sales.reconciliation" -> MapSet.member?(sal_draft, todo.source_id)
        "purchase.reconciliation" -> MapSet.member?(pur_draft, todo.source_id)
        _ -> false
      end
    end)
  end

  defp draft_sal_ids([]), do: MapSet.new()

  defp draft_sal_ids(ids) do
    require Ash.Query

    SynieCore.Acc.VatInvoice
    |> Ash.Query.filter(sal_reconciliation_id in ^ids and status == :draft)
    |> Ash.read!(authorize?: false)
    |> MapSet.new(& &1.sal_reconciliation_id)
  end

  defp draft_pur_ids([]), do: MapSet.new()

  defp draft_pur_ids(ids) do
    require Ash.Query

    SynieCore.Acc.VatInvoice
    |> Ash.Query.filter(pur_reconciliation_id in ^ids and status == :draft)
    |> Ash.read!(authorize?: false)
    |> MapSet.new(& &1.pur_reconciliation_id)
  end
end

defmodule SynieCore.Sys.Todo.MyStateField do
  @moduledoc "当前 actor 在本待办上的痕迹字段(已读/忽略时点)。批量查痕迹表,不依赖关系预载。"

  use Ash.Resource.Calculation

  require Ash.Query

  @impl true
  def load(_query, _opts, _context), do: []

  @impl true
  def calculate(records, opts, context) do
    field = Keyword.fetch!(opts, :field)
    user_id = actor_user_id(context.actor)
    state_by_todo = load_states(records, user_id)

    Enum.map(records, fn todo ->
      case Map.get(state_by_todo, todo.id) do
        nil -> nil
        state -> Map.get(state, field)
      end
    end)
  end

  defp load_states(_records, nil), do: %{}

  defp load_states(records, user_id) do
    ids = Enum.map(records, & &1.id)

    if ids == [] do
      %{}
    else
      SynieCore.Sys.TodoState
      |> Ash.Query.filter(todo_id in ^ids and user_id == ^user_id)
      |> Ash.read!(authorize?: false)
      |> Map.new(&{&1.todo_id, &1})
    end
  end

  defp actor_user_id(%SynieCore.Authz.Actor{user_id: id}), do: id
  defp actor_user_id(_), do: nil
end

defmodule SynieCore.Sys.Todo.EffectivelyDismissed do
  @moduledoc """
  当前 actor 是否有效忽略本待办:有 dismissed_at 且复位基准仍等于源单状态变化时点。
  """

  use Ash.Resource.Calculation

  require Ash.Query

  @impl true
  def load(_query, _opts, _context), do: []

  @impl true
  def calculate(records, _opts, context) do
    user_id = actor_user_id(context.actor)
    state_by_todo = load_states(records, user_id)

    Enum.map(records, fn todo ->
      case Map.get(state_by_todo, todo.id) do
        %{dismissed_at: dismissed_at, reset_basis_at: basis}
        when not is_nil(dismissed_at) and not is_nil(basis) ->
          DateTime.compare(basis, todo.source_changed_at) == :eq

        _ ->
          false
      end
    end)
  end

  defp load_states(_records, nil), do: %{}

  defp load_states(records, user_id) do
    ids = Enum.map(records, & &1.id)

    if ids == [] do
      %{}
    else
      SynieCore.Sys.TodoState
      |> Ash.Query.filter(todo_id in ^ids and user_id == ^user_id)
      |> Ash.read!(authorize?: false)
      |> Map.new(&{&1.todo_id, &1})
    end
  end

  defp actor_user_id(%SynieCore.Authz.Actor{user_id: id}), do: id
  defp actor_user_id(_), do: nil
end

defmodule SynieCore.Sys.Todo.PartyName do
  @moduledoc "对手显示名快照(按 party_type 查主数据 name,失败回空串)。"

  use Ash.Resource.Calculation

  @impl true
  def load(_query, _opts, _context), do: []

  @impl true
  def calculate(records, _opts, _context) do
    by_type =
      records
      |> Enum.group_by(& &1.party_type)
      |> Map.new(fn {type, group} ->
        ids = group |> Enum.map(& &1.party_id) |> Enum.uniq()
        {type, lookup_names(type, ids)}
      end)

    Enum.map(records, fn todo ->
      by_type
      |> Map.get(todo.party_type, %{})
      |> Map.get(todo.party_id, "")
    end)
  end

  defp lookup_names(_type, []), do: %{}

  defp lookup_names(type, ids) do
    case SynieCore.Acc.PartyType.party_resources()[type] do
      nil ->
        %{}

      resource ->
        require Ash.Query

        resource
        |> Ash.Query.filter(id in ^ids)
        |> Ash.read!(authorize?: false)
        |> Map.new(fn r -> {r.id, Map.get(r, :name) || Map.get(r, :short_name) || ""} end)
    end
  end
end

defmodule SynieCore.Sys.Todo do
  @moduledoc """
  待办(横切提醒设施),对应 `sys_todo` 表。

  从源单据状态推导的物化提醒:对账单进入确认态时同事务产生,发票审核结单/
  撤回确认时同事务关闭,发票作废/红冲退回确认态时新建复活。不引流程引擎、
  无指派/截止/优先级;用户侧只有已读/忽略个人痕迹(见 `SynieCore.Sys.TodoState`)。

  可见性=权限圈人(可见该公司 + 持 `acc.vat_invoice:create`),不设独立权限码;
  菜单无权限门槛(先例:收发货历史)。

  故意不接审计 Fragment:个人已读/忽略高频且低价值;产生/关闭已由源单据
  (对账确认/发票审核)审计覆盖,再记一份是噪声(同 GlEntry 不接审计先例)。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    primary_read_warning?: false

  require Ash.Query

  postgres do
    table "sys_todo"
    repo SynieCore.Repo

    custom_indexes do
      index [:company_id, :status, :inserted_at]
      index [:source_type, :source_id]

      index [:source_type, :source_id],
        unique: true,
        where: "status = 'active'",
        name: "sys_todo_one_active_per_source_index"
    end
  end

  graphql do
    type :sys_todo
  end

  policies do
    bypass actor_attribute_equals(:super_admin, true) do
      authorize_if always()
    end

    # 读/未读计数:持发票创建权限;公司范围 FilterCheck 收空集
    # (无权限 → Forbidden,与「看不到」等价;见测试)
    policy action([:read, :unread_count, :mark_read, :dismiss]) do
      authorize_if {SynieCore.Authz.Checks.HasPermission, code: "acc.vat_invoice:create"}
    end

    policy action_type([:read, :update]) do
      authorize_if SynieCore.Authz.Checks.CompanyScope
    end
  end

  # 复用发票创建权限码,不进权限目录
  def permission_prefix, do: "sys.todo"
  def permission_actions, do: []

  def poly_refs do
    %{
      party_id: %{
        discriminator: :party_type,
        variants: SynieCore.Acc.PartyType.party_resources()
      },
      source_id: %{
        discriminator: :source_type,
        variants: %{
          "sales.reconciliation" => {SynieCore.Sales.Reconciliation, "销售对账单"},
          "purchase.reconciliation" => {SynieCore.Purchase.Reconciliation, "采购对账单"}
        }
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

      argument :tab, :string do
        # nil=不按状态过滤(内部/裸 query);前端/GraphQL 显式传 active|history|recent
        allow_nil? true
        description "活跃/历史/最近(铃铛下拉: active|history|recent);缺省不过滤状态"
      end

      argument :include_dismissed, :boolean do
        allow_nil? false
        default false
        description "活跃 tab 是否包含本人已忽略(默认否)"
      end

      prepare build(
                load: [
                  :draft_invoice_linked,
                  :party_name,
                  :my_read_at,
                  :my_dismissed_at,
                  :dismissed
                ]
              )

      prepare fn query, context ->
        tab = Ash.Query.get_argument(query, :tab)
        include_dismissed = Ash.Query.get_argument(query, :include_dismissed) || false

        query =
          case tab do
            "history" -> Ash.Query.filter(query, status == :closed)
            "active" -> Ash.Query.filter(query, status == :active)
            "recent" -> Ash.Query.filter(query, status == :active)
            # nil 或未知:不过滤状态(生产者/测试内部查询)
            _ -> query
          end

        query =
          if Enum.empty?(query.sort) do
            Ash.Query.sort(query, inserted_at: :desc, id: :desc)
          else
            query
          end

        query =
          if tab in ["active", "recent"] and not include_dismissed do
            exclude_dismissed(query, context.actor)
          else
            query
          end

        if tab == "recent" do
          Ash.Query.limit(query, 8)
        else
          query
        end
      end
    end

    # 内部:生产者同事务写,不经 GraphQL
    create :create_internal do
      accept [
        :type,
        :source_type,
        :source_id,
        :source_no,
        :company_id,
        :party_type,
        :party_id,
        :amount,
        :source_changed_at,
        :created_by_id
      ]

      change set_attribute(:status, :active)
    end

    # 内部:关闭活跃待办
    update :close_internal do
      accept [:closed_reason]
      require_atomic? false

      change fn changeset, _context ->
        changeset
        |> Ash.Changeset.force_change_attribute(:status, :closed)
        |> Ash.Changeset.force_change_attribute(:closed_at, DateTime.utc_now())
      end
    end

    update :mark_read do
      accept []
      require_atomic? false

      # 必须弄脏 changeset,否则无属性变更时 Ash 可能跳过 after_action
      change fn changeset, context ->
        changeset
        |> Ash.Changeset.force_change_attribute(:updated_at, DateTime.utc_now())
        |> Ash.Changeset.after_action(fn _cs, todo ->
          upsert_state!(todo, context.actor, :read)
          {:ok, todo}
        end)
      end
    end

    update :dismiss do
      accept []
      require_atomic? false

      change fn changeset, context ->
        changeset
        |> Ash.Changeset.force_change_attribute(:updated_at, DateTime.utc_now())
        |> Ash.Changeset.after_action(fn _cs, todo ->
          upsert_state!(todo, context.actor, :dismiss)
          {:ok, todo}
        end)
      end
    end

    action :unread_count, :integer do
      description "当前用户未读数:活跃且未有效忽略且未读"

      run fn _input, context ->
        actor = context.actor

        cond do
          is_nil(actor) ->
            {:ok, 0}

          not SynieCore.Authz.has_permission?(actor, "acc.vat_invoice:create") and
              not actor.super_admin ->
            {:ok, 0}

          true ->
            todos =
              __MODULE__
              |> Ash.Query.for_read(:read, %{tab: "active", include_dismissed: false},
                actor: actor
              )
              |> Ash.read!(actor: actor)

            user_id = actor.user_id
            todo_ids = Enum.map(todos, & &1.id)

            read_ids =
              if todo_ids == [] do
                MapSet.new()
              else
                SynieCore.Sys.TodoState
                |> Ash.Query.filter(
                  todo_id in ^todo_ids and user_id == ^user_id and not is_nil(read_at)
                )
                |> Ash.read!(authorize?: false)
                |> MapSet.new(& &1.todo_id)
              end

            count = Enum.count(todos, fn todo -> not MapSet.member?(read_ids, todo.id) end)
            {:ok, count}
        end
      end
    end
  end

  attributes do
    uuid_primary_key :id

    attribute :type, SynieCore.Sys.TodoType do
      allow_nil? false
      public? true
      description "待办类型(开票/收票)"
    end

    attribute :source_type, :string do
      allow_nil? false
      public? true
      description "源单据类型(多态判别,如 sales.reconciliation)"
    end

    attribute :source_id, :uuid do
      allow_nil? false
      public? true
      description "源单据"
    end

    attribute :source_no, :string do
      allow_nil? false
      public? true
      constraints max_length: 64
      description "源单据号快照"
    end

    attribute :party_type, SynieCore.Acc.PartyType do
      allow_nil? false
      public? true
      description "对手类型快照"
    end

    attribute :party_id, :uuid do
      allow_nil? false
      public? true
      description "对手快照"
    end

    attribute :amount, :decimal do
      allow_nil? false
      public? true
      default Decimal.new(0)
      description "金额快照(对账单本币合计)"
    end

    attribute :status, SynieCore.Sys.TodoStatus do
      allow_nil? false
      public? true
      default :active
      writable? false
      description "状态"
    end

    attribute :closed_reason, SynieCore.Sys.TodoClosedReason do
      public? true
      description "关闭触发来源"
    end

    attribute :source_changed_at, :utc_datetime_usec do
      allow_nil? false
      public? true
      description "源单状态变化时点(忽略复位基准)"
    end

    attribute :closed_at, :utc_datetime_usec do
      public? true
      writable? false
      description "关闭时点"
    end

    create_timestamp :inserted_at, public?: true, description: "产生时间"
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
      attribute_writable? true
      description "触发操作人"
    end

    has_many :states, SynieCore.Sys.TodoState do
      destination_attribute :todo_id
      public? false
      description "用户痕迹"
    end
  end

  calculations do
    calculate :draft_invoice_linked, :boolean, SynieCore.Sys.Todo.DraftInvoiceLinked do
      public? true
      description "草稿关联中(存在草稿态关联发票)"
    end

    calculate :party_name, :string, SynieCore.Sys.Todo.PartyName do
      public? true
      description "对手显示名"
    end

    calculate :my_read_at, :utc_datetime_usec, {SynieCore.Sys.Todo.MyStateField, field: :read_at} do
      public? true
      description "当前用户已读时点"
    end

    calculate :my_dismissed_at,
              :utc_datetime_usec,
              {SynieCore.Sys.Todo.MyStateField, field: :dismissed_at} do
      public? true
      description "当前用户忽略时点"
    end

    calculate :dismissed, :boolean, SynieCore.Sys.Todo.EffectivelyDismissed do
      public? true
      description "当前用户是否有效忽略"
    end
  end

  # ── 生产者 API(同事务,authorize?: false) ────────────────────────────────

  @source_sales "sales.reconciliation"
  @source_purchase "purchase.reconciliation"

  @doc false
  def open_for_sales_reconciliation!(reconciliation, opts \\ []) do
    open!(
      type: :issue_invoice,
      source_type: @source_sales,
      source_id: reconciliation.id,
      source_no: reconciliation.reconciliation_no,
      company_id: reconciliation.company_id,
      party_type: reconciliation.party_type,
      party_id: reconciliation.party_id,
      amount: base_amount(reconciliation),
      created_by_id: Keyword.get(opts, :user_id)
    )
  end

  @doc false
  def open_for_purchase_reconciliation!(reconciliation, opts \\ []) do
    open!(
      type: :receive_invoice,
      source_type: @source_purchase,
      source_id: reconciliation.id,
      source_no: reconciliation.reconciliation_no,
      company_id: reconciliation.company_id,
      party_type: reconciliation.party_type,
      party_id: reconciliation.party_id,
      amount: base_amount(reconciliation),
      created_by_id: Keyword.get(opts, :user_id)
    )
  end

  @doc false
  def close_for_sales_reconciliation!(reconciliation_id, reason) do
    close!(@source_sales, reconciliation_id, reason)
  end

  @doc false
  def close_for_purchase_reconciliation!(reconciliation_id, reason) do
    close!(@source_purchase, reconciliation_id, reason)
  end

  defp open!(attrs) do
    now = DateTime.utc_now()

    todo =
      __MODULE__
      |> Ash.Changeset.for_create(
        :create_internal,
        Map.new(attrs) |> Map.put(:source_changed_at, now)
      )
      |> Ash.create!(authorize?: false)

    broadcast_stamp(todo)
    todo
  end

  defp close!(source_type, source_id, reason) do
    todos =
      __MODULE__
      |> Ash.Query.filter(
        source_type == ^source_type and source_id == ^source_id and status == :active
      )
      |> Ash.read!(authorize?: false)

    Enum.map(todos, fn todo ->
      case todo
           |> Ash.Changeset.for_update(:close_internal, %{closed_reason: reason})
           |> Ash.update(authorize?: false) do
        {:ok, closed} ->
          broadcast_stamp(closed)
          closed

        {:error, error} ->
          raise "close_internal failed: #{Exception.message(error)}"
      end
    end)
  end

  defp base_amount(reconciliation) do
    case Map.get(reconciliation, :base_gross_total) do
      %Decimal{} = amount ->
        amount

      _ ->
        reconciliation
        |> Ash.load!([:base_gross_total], authorize?: false)
        |> Map.get(:base_gross_total) || Decimal.new(0)
    end
  end

  defp upsert_state!(todo, %SynieCore.Authz.Actor{user_id: user_id}, kind) do
    now = DateTime.utc_now()

    existing =
      SynieCore.Sys.TodoState
      |> Ash.Query.filter(todo_id == ^todo.id and user_id == ^user_id)
      |> Ash.read_one!(authorize?: false)

    attrs =
      case kind do
        :read ->
          %{read_at: now}

        :dismiss ->
          %{
            dismissed_at: now,
            reset_basis_at: todo.source_changed_at,
            read_at: now
          }
      end

    case existing do
      nil ->
        SynieCore.Sys.TodoState
        |> Ash.Changeset.for_create(
          :create_internal,
          Map.merge(attrs, %{todo_id: todo.id, user_id: user_id})
        )
        |> Ash.create!(authorize?: false)

      state ->
        state
        |> Ash.Changeset.for_update(:upsert_internal, attrs)
        |> Ash.update!(authorize?: false)
    end
  end

  defp upsert_state!(_todo, _actor, _kind), do: :ok

  # 活跃列表排除本人有效忽略:先取痕迹再滤 id(活跃待办量级小,避免复杂 exists 表达式)
  defp exclude_dismissed(query, %SynieCore.Authz.Actor{user_id: user_id}) do
    dismissed_ids =
      SynieCore.Sys.TodoState
      |> Ash.Query.filter(user_id == ^user_id and not is_nil(dismissed_at))
      |> Ash.Query.load(:todo)
      |> Ash.read!(authorize?: false)
      |> Enum.filter(fn state ->
        state.todo &&
          state.todo.status == :active &&
          not is_nil(state.reset_basis_at) &&
          DateTime.compare(state.reset_basis_at, state.todo.source_changed_at) == :eq
      end)
      |> Enum.map(& &1.todo_id)

    if dismissed_ids == [] do
      query
    else
      Ash.Query.filter(query, id not in ^dismissed_ids)
    end
  end

  defp exclude_dismissed(query, _), do: query

  # 轻量戳:core 不依赖 Phoenix.PubSub,经 telemetry 抛事件;
  # web 层可 attach 再广播给在线前端(前端轮询仍为兜底)。
  defp broadcast_stamp(todo) do
    :telemetry.execute(
      [:synie_core, :sys_todo, :changed],
      %{count: 1},
      %{
        type: todo.type,
        company_id: todo.company_id,
        status: todo.status,
        id: todo.id
      }
    )

    :ok
  end
end
