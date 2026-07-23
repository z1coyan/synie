defmodule SynieCore.Setup do
  @moduledoc """
  初始化向导(Setup)门面:全新部署首启时的一次性业务初始化。

  门控:`sys_setting.setup_completed_at` 空 = 未初始化,向导开放;落库后相关接口永久关闭。
  空库只需 `mix ecto.migrate` 即可启动应用并进入向导——无需再跑 `seeds.exs`。
  完成时幂等种子:内置存储接入 local、编号规则、物料两级分类、机加工常用计量单位,
  并写首选语言、落完成旗标;可选写入示例业务数据(见 `Setup.SampleData`)。
  中间步骤(公司创建/科目表初始化等)由前端向导调既有 mutation(超管身份),不在此门面内。
  迁移仍种子 CNY、内置 admin 角色、行情用吨/千克与各单行配置表。
  常用货币预置时全部停用;选定本币后 `activate_only_base_currency/1` 仅启用本币,其余须手动启用。

  全部为受信内部路径(`authorize?: false`);GraphQL schema 负责按接口要求校验 actor。
  """

  require Ash.Query

  alias SynieCore.Accounts.User
  alias SynieCore.Authz.Actor
  alias SynieCore.Base.Currency
  alias SynieCore.Base.Unit
  alias SynieCore.Files.StorageEndpoint
  alias SynieCore.Inv.MaterialCategory
  alias SynieCore.Numbering.Rule
  alias SynieCore.Repo
  alias SynieCore.Setup.SampleData
  alias SynieCore.Sys.Setting

  @languages ["zh-CN", "en-US"]

  # 常用货币预置清单:向导公司步进入时按 iso_code 幂等补齐(老环境不经向导,不强塞)
  @common_currencies [
    %{name: "人民币", iso_code: "CNY", symbol: "￥"},
    %{name: "美元", iso_code: "USD", symbol: "$"},
    %{name: "欧元", iso_code: "EUR", symbol: "€"},
    %{name: "日元", iso_code: "JPY", symbol: "¥"},
    %{name: "港币", iso_code: "HKD", symbol: "HK$"},
    %{name: "新台币", iso_code: "TWD", symbol: "NT$"},
    %{name: "英镑", iso_code: "GBP", symbol: "£"},
    %{name: "韩元", iso_code: "KRW", symbol: "₩"},
    %{name: "新加坡元", iso_code: "SGD", symbol: "S$"},
    %{name: "澳大利亚元", iso_code: "AUD", symbol: "A$"},
    %{name: "加拿大元", iso_code: "CAD", symbol: "C$"},
    %{name: "瑞士法郎", iso_code: "CHF", symbol: "CHF"},
    %{name: "澳门元", iso_code: "MOP", symbol: "MOP$"},
    %{name: "泰铢", iso_code: "THB", symbol: "฿"},
    %{name: "马来西亚林吉特", iso_code: "MYR", symbol: "RM"},
    %{name: "印尼盾", iso_code: "IDR", symbol: "Rp"},
    %{name: "越南盾", iso_code: "VND", symbol: "₫"},
    %{name: "菲律宾比索", iso_code: "PHP", symbol: "₱"},
    %{name: "印度卢比", iso_code: "INR", symbol: "₹"},
    %{name: "俄罗斯卢布", iso_code: "RUB", symbol: "₽"}
  ]

  # 业务单据编号:主模块字母(子模块字母)-业务日期YYYYMMDD-4 位序号,按公司计数。
  # 前缀约定:主模块字母(子模块字母),如销售订单 S(O)、采购入库 P(R)。
  @doc_numbering_rules [
    # 销售
    {"sales.order", "销售订单编号", "S(O)", "order_date"},
    {"sales.quotation", "销售报价编号", "S(Q)", "quotation_date"},
    {"sales.delivery", "销售发货编号", "S(D)", "delivery_date"},
    {"sales.reconciliation", "销售对账编号", "S(R)", "posting_date"},
    # 采购
    {"purchase.order", "采购订单编号", "P(O)", "order_date"},
    {"purchase.quotation", "采购报价编号", "P(Q)", "quotation_date"},
    {"purchase.receipt", "采购入库编号", "P(R)", "receipt_date"},
    {"purchase.reconciliation", "采购对账编号", "P(C)", "posting_date"},
    # 库存
    {"inv.stock_doc", "手工出入库单编号", "I(D)", "doc_date"},
    {"inv.stock_transfer", "手工调拨单编号", "I(T)", "doc_date"},
    {"inv.stock_count", "库存盘点单编号", "I(C)", "posting_date"},
    # 财务
    {"acc.gl_journal", "会计凭证编号", "A(J)", "date"},
    {"acc.vat_invoice", "增值税发票编号", "A(I)", "invoice_date"},
    {"acc.bill_transaction", "承兑交易编号", "A(B)", "occurred_on"},
    {"acc.expense_report", "费用报销编号", "A(E)", "expense_date"}
  ]

  # 机加工工厂常用计量单位。元组:{unit_type, is_base, name, symbol, ratio_string}
  # ratio = 折合同类型基准单位的量(基准 ratio=1)。symbol 全局唯一,已存在则跳过。
  # 重量基准「吨」与千克由行情迁移已种子,此处只补克等;不抢已有类型的 is_base。
  @machining_units [
    # 长度:机加以毫米为基准
    {:length, true, "毫米", "mm", "1"},
    {:length, false, "微米", "μm", "0.001"},
    {:length, false, "厘米", "cm", "10"},
    {:length, false, "米", "m", "1000"},
    {:length, false, "英寸", "in", "25.4"},
    # 面积:以平方毫米为基准(钣金/截面)
    {:area, true, "平方毫米", "mm²", "1"},
    {:area, false, "平方厘米", "cm²", "100"},
    {:area, false, "平方米", "m²", "1000000"},
    # 重量:迁移已有 吨(基)/千克;补克(相对吨)
    {:weight, false, "克", "g", "0.000001"},
    # 数量:件为基准;其余多为计数口径(物料级换算另挂单位转换)
    {:quantity, true, "件", "pcs", "1"},
    {:quantity, false, "只", "只", "1"},
    {:quantity, false, "个", "个", "1"},
    {:quantity, false, "套", "套", "1"},
    {:quantity, false, "台", "台", "1"},
    {:quantity, false, "片", "片", "1"},
    {:quantity, false, "根", "根", "1"},
    {:quantity, false, "支", "支", "1"},
    {:quantity, false, "块", "块", "1"},
    {:quantity, false, "张", "张", "1"},
    {:quantity, false, "箱", "箱", "1"},
    {:quantity, false, "包", "包", "1"},
    {:quantity, false, "卷", "卷", "1"},
    {:quantity, false, "捆", "捆", "1"},
    {:quantity, false, "打", "打", "12"},
    {:quantity, false, "次", "次", "1"},
    {:quantity, false, "项", "项", "1"}
  ]

  # 物料两级分类:大类(非叶子) + 叶子子类;叶子编号形态 大类(子类),直接作物料编号前缀。
  @material_categories [
    {"F", "产品",
     [
       {"F(P)", "客户产品成品"},
       {"F(S)", "半成品"},
       {"F(G)", "通用成品"}
     ]},
    {"P", "包材",
     [
       {"P(W)", "木箱"},
       {"P(C)", "纸箱"},
       {"P(B)", "袋与填充"}
     ]},
    {"E", "设备工量具",
     [
       {"E(E)", "设备"},
       {"E(T)", "工量具"}
     ]},
    {"M", "劳保耗材",
     [
       {"M(L)", "劳保用品"},
       {"M(C)", "耗材"}
     ]},
    {"S", "服务",
     [
       {"S(G)", "一般服务"}
     ]}
  ]

  @doc "向导状态:是否已初始化、库中是否已有用户(决定向导从哪步续做)。"
  @spec status() :: %{initialized: boolean(), has_users: boolean()}
  def status do
    %{initialized: initialized?(), has_users: users_exist?()}
  end

  @doc "系统是否已完成初始化(完成旗标已落)。"
  @spec initialized?() :: boolean()
  def initialized? do
    case Setting.get() do
      %{setup_completed_at: %DateTime{}} -> true
      _ -> false
    end
  end

  @doc """
  创建首个用户并打超级管理员旗标(返回可用于签发登录态的用户)。
  仅在「未初始化 且 库中无用户」时可用;两条件之外即拒绝,天然幂等。
  """
  @spec create_first_user(map()) :: {:ok, User.t()} | {:error, term()}
  def create_first_user(%{username: _, password: _} = attrs) do
    cond do
      initialized?() ->
        {:error, "系统已完成初始化"}

      users_exist?() ->
        {:error, "已存在用户,请直接登录"}

      true ->
        Repo.transaction(fn ->
          {user, n1} =
            User
            |> Ash.Changeset.for_create(:create, Map.take(attrs, [:username, :name, :password]))
            |> Ash.create!(authorize?: false, return_notifications?: true)

          {user, n2} =
            user
            |> Ash.Changeset.for_update(:set_super_admin, %{})
            |> Ash.update!(authorize?: false, return_notifications?: true)

          {user, n1 ++ n2}
        end)
        |> case do
          # 通知在提交后补发(事务内直发会把未提交事件投递出去)
          {:ok, {user, notifications}} ->
            Ash.Notifier.notify(notifications)
            {:ok, user}

          {:error, error} ->
            {:error, error}
        end
    end
  rescue
    e -> {:error, e}
  end

  @doc """
  预置常用货币(按 iso_code 幂等,返回本次新建条数);仅未初始化时可用。

  预置一律停用(`active: false`)。尚无公司时还会把清单内已有币种(含迁移保底的 CNY)
  一并重置为停用,待选定本币后由 `activate_only_base_currency/1` 只启用本币。
  已有公司(续作)不强制重置,避免把已启用的本币关掉。
  """
  @spec seed_common_currencies() :: {:ok, non_neg_integer()} | {:error, term()}
  def seed_common_currencies do
    if initialized?() do
      {:error, "系统已完成初始化"}
    else
      codes = Enum.map(@common_currencies, & &1.iso_code)

      existing =
        Currency
        |> Ash.Query.filter(iso_code in ^codes)
        |> Ash.read!(authorize?: false)

      existing_codes = MapSet.new(existing, & &1.iso_code)

      created =
        @common_currencies
        |> Enum.reject(&(&1.iso_code in existing_codes))
        |> Enum.map(fn attrs ->
          Currency
          |> Ash.Changeset.for_create(:create, Map.put(attrs, :active, false))
          |> Ash.create!(authorize?: false)
        end)

      # 首启(尚无公司):清单内已有币种(如迁移 CNY)一并停用,保证选本币前全停
      unless companies_exist?() do
        existing
        |> Enum.filter(& &1.active)
        |> Enum.each(fn currency ->
          currency
          |> Ash.Changeset.for_update(:update, %{active: false})
          |> Ash.update!(authorize?: false)
        end)
      end

      {:ok, length(created)}
    end
  end

  @doc """
  初始化向导:选定本币后仅启用该币种,其余全部停用。
  须在建公司之前调用(公司本币校验要求启用中的货币);仅未初始化时可用。
  """
  @spec activate_only_base_currency(String.t()) :: :ok | {:error, term()}
  def activate_only_base_currency(currency_id) when is_binary(currency_id) do
    if initialized?() do
      {:error, "系统已完成初始化"}
    else
      case Ash.get(Currency, currency_id, authorize?: false) do
        {:ok, base} ->
          Repo.transaction(fn ->
            # 停用全部启用中的非本币;再确保本币启用。事务内 update 须 return_notifications?,
            # 提交后再统一 notify(与 complete 同模式)。
            n_off =
              Currency
              |> Ash.Query.filter(active == true and id != ^currency_id)
              |> Ash.read!(authorize?: false)
              |> Enum.flat_map(fn currency ->
                {_c, notifications} =
                  currency
                  |> Ash.Changeset.for_update(:update, %{active: false})
                  |> Ash.update!(authorize?: false, return_notifications?: true)

                notifications
              end)

            n_on =
              if base.active do
                []
              else
                {_c, notifications} =
                  base
                  |> Ash.Changeset.for_update(:update, %{active: true})
                  |> Ash.update!(authorize?: false, return_notifications?: true)

                notifications
              end

            n_off ++ n_on
          end)
          |> case do
            {:ok, notifications} ->
              Ash.Notifier.notify(notifications)
              :ok

            {:error, error} ->
              {:error, error}
          end

        {:error, _} ->
          {:error, "币种不存在"}
      end
    end
  rescue
    e -> {:error, e}
  end

  defp companies_exist? do
    SynieCore.Base.Company |> Ash.exists?(authorize?: false)
  end

  @doc """
  完成初始化:写入当前用户的首选语言;幂等种子内置存储接入、编号规则、物料两级分类、
  机加工常用计量单位;可选示例业务数据(覆盖全业务链,见 `Setup.SampleData`);落完成旗标(同事务)。
  落旗后 setup 各接口随之关闭;仅未初始化时可用。

  选项:
  - `seed_sample_data: true` — 为首个公司写入全业务链示例数据(无公司时忽略)
  """
  @spec complete(Actor.t(), String.t(), keyword()) :: :ok | {:error, term()}
  def complete(%Actor{user_id: user_id} = actor, language, opts \\ []) do
    seed_sample? = Keyword.get(opts, :seed_sample_data, false)

    cond do
      initialized?() ->
        {:error, "系统已完成初始化"}

      language not in @languages ->
        {:error, "不支持的语言"}

      true ->
        Repo.transaction(fn ->
          user = Ash.get!(User, user_id, authorize?: false)

          {_user, n1} =
            user
            |> Ash.Changeset.for_update(:update, %{})
            |> Ash.Changeset.force_change_attribute(:preferred_language, language)
            |> Ash.update!(authorize?: false, actor: actor, return_notifications?: true)

          n_storage = seed_local_storage!()
          n_rules = seed_numbering_rules!()
          n_cats = seed_material_categories!()
          n_units = seed_units!()

          # 示例数据依赖分类/单位/编号规则,须在其后;无公司时跳过(续作异常路径)
          n_sample =
            if seed_sample? do
              case first_company_id() do
                nil ->
                  []

                company_id ->
                  {_summary, notifications} = SampleData.seed!(company_id, actor)
                  notifications
              end
            else
              []
            end

          {setting, n2} =
            Setting.get()
            |> Ash.Changeset.for_update(:update, %{})
            |> Ash.Changeset.force_change_attribute(:setup_completed_at, DateTime.utc_now())
            |> Ash.update!(authorize?: false, actor: actor, return_notifications?: true)

          {setting, n1 ++ n_storage ++ n_rules ++ n_cats ++ n_units ++ n_sample ++ n2}
        end)
        |> case do
          {:ok, {_setting, notifications}} ->
            Ash.Notifier.notify(notifications)
            :ok

          {:error, error} ->
            {:error, error}
        end
    end
  rescue
    e -> {:error, e}
  end

  defp first_company_id do
    case SynieCore.Base.Company
         |> Ash.Query.limit(1)
         |> Ash.read!(authorize?: false) do
      [%{id: id} | _] -> id
      _ -> nil
    end
  end

  # ---------------------------------------------------------------------------
  # 完成时种子:存储接入 + 编号规则 + 物料分类 + 计量单位(均幂等,已有则跳过不覆盖)
  # 事务内 create 须 return_notifications?: true,由 complete 提交后统一 notify。
  # ---------------------------------------------------------------------------

  # 内置 local 接入(全局默认,不可删除)。已存在则跳过,不覆盖用户改过的 root。
  # root = UPLOADS_ROOT 环境变量,缺省 "uploads"。
  defp seed_local_storage! do
    existing =
      StorageEndpoint
      |> Ash.Query.filter(name == "local")
      |> Ash.read_one!(authorize?: false)

    if existing do
      []
    else
      root = System.get_env("UPLOADS_ROOT") || "uploads"

      {_ep, notifications} =
        StorageEndpoint
        |> Ash.Changeset.for_create(:create, %{
          name: "local",
          label: "本地存储",
          kind: :local,
          root: root
        })
        |> Ash.Changeset.force_change_attribute(:builtin, true)
        |> Ash.Changeset.force_change_attribute(:is_default, true)
        |> Ash.create!(authorize?: false, return_notifications?: true)

      notifications
    end
  end

  # 物料:分类编号+客户编号(空则省略)+"-"+不补零序号;全局主数据不按公司。
  # label 为前端预览冗余(后端取号忽略),与 SegmentsEditor 拼装格式一致,
  # 缺 label 时列表/示例会裸显 [category.code][customer.code]-1。
  # 员工:无业务日期字段,H(E)-4 位序号;全局。
  # 其余单据:前缀-业务日期-4 位序号;按公司计数。
  defp seed_numbering_rules! do
    n1 =
      ensure_numbering_rule!("inv.material", "物料编号", false, [
        %{
          "type" => "field",
          "field" => "category.code",
          "label" => "物料分类·分类编号"
        },
        %{
          "type" => "field",
          "field" => "customer.code",
          "label" => "所属客户(仅客户物料)·客户编号"
        },
        %{"type" => "text", "value" => "-"},
        %{"type" => "seq", "padding" => 0}
      ])

    n2 =
      ensure_numbering_rule!("hr.employee", "员工编号", false, [
        %{"type" => "text", "value" => "H(E)-"},
        %{"type" => "seq", "padding" => 4}
      ])

    # 生产域:工序/工艺模板编号,全局主数据不按公司,前缀-4 位序号(同员工先例)
    n3 =
      ensure_numbering_rule!("mfg.operation", "工序编号", false, [
        %{"type" => "text", "value" => "M(O)-"},
        %{"type" => "seq", "padding" => 4}
      ])

    n4 =
      ensure_numbering_rule!("mfg.route_template", "工艺模板编号", false, [
        %{"type" => "text", "value" => "M(T)-"},
        %{"type" => "seq", "padding" => 4}
      ])

    n_docs =
      Enum.flat_map(@doc_numbering_rules, fn {resource, name, prefix, date_field} ->
        ensure_numbering_rule!(resource, name, true, [
          %{"type" => "text", "value" => "#{prefix}-"},
          %{
            "type" => "field",
            "field" => date_field,
            "format" => "YYYYMMDD",
            "label" => date_field_label(date_field)
          },
          %{"type" => "text", "value" => "-"},
          %{"type" => "seq", "padding" => 4}
        ])
      end)

    n1 ++ n2 ++ n3 ++ n4 ++ n_docs
  end

  defp date_field_label("order_date"), do: "订单日期"
  defp date_field_label("quotation_date"), do: "报价日期"
  defp date_field_label("delivery_date"), do: "发货日期"
  defp date_field_label("receipt_date"), do: "入库日期"
  defp date_field_label("doc_date"), do: "业务日期"
  defp date_field_label("posting_date"), do: "业务日期"
  defp date_field_label("invoice_date"), do: "开票日期"
  defp date_field_label("occurred_on"), do: "发生日期"
  defp date_field_label("expense_date"), do: "费用日期"
  defp date_field_label("date"), do: "凭证日期"
  defp date_field_label(other), do: other

  defp ensure_numbering_rule!(resource, name, per_company, segments) do
    existing =
      Rule
      |> Ash.Query.filter(resource == ^resource)
      |> Ash.read!(authorize?: false)
      |> List.first()

    if existing do
      []
    else
      {_rule, notifications} =
        Rule
        |> Ash.Changeset.for_create(:create, %{
          resource: resource,
          name: name,
          segments: segments,
          per_company: per_company,
          enabled: true
        })
        |> Ash.create!(authorize?: false, return_notifications?: true)

      notifications
    end
  end

  # 按 symbol 幂等;拟作基准但该类型已有基准时改为非基准(不抢迁移/用户已有基准)。
  defp seed_units! do
    Enum.flat_map(@machining_units, fn {unit_type, want_base, name, symbol, ratio} ->
      existing =
        Unit
        |> Ash.Query.filter(symbol == ^symbol)
        |> Ash.read_one!(authorize?: false)

      if existing do
        []
      else
        is_base = want_base and not type_has_base?(unit_type)

        {_unit, notifications} =
          Unit
          |> Ash.Changeset.for_create(:create, %{
            unit_type: unit_type,
            is_base: is_base,
            name: name,
            symbol: symbol,
            ratio: Decimal.new(ratio)
          })
          |> Ash.create!(authorize?: false, return_notifications?: true)

        notifications
      end
    end)
  end

  defp type_has_base?(unit_type) do
    Unit
    |> Ash.Query.filter(unit_type == ^unit_type and is_base == true)
    |> Ash.exists?(authorize?: false)
  end

  # 已有任一分类则整棵跳过,不覆盖用户改过的分类树。
  defp seed_material_categories! do
    any_category? =
      MaterialCategory
      |> Ash.Query.limit(1)
      |> Ash.read!(authorize?: false)
      |> Enum.any?()

    if any_category? do
      []
    else
      Enum.flat_map(@material_categories, fn {code, name, children} ->
        {parent, n_parent} =
          MaterialCategory
          |> Ash.Changeset.for_create(:create, %{
            code: code,
            name: name,
            is_leaf: false,
            active: true
          })
          |> Ash.create!(authorize?: false, return_notifications?: true)

        n_children =
          Enum.flat_map(children, fn {child_code, child_name} ->
            {_child, notifications} =
              MaterialCategory
              |> Ash.Changeset.for_create(:create, %{
                code: child_code,
                name: child_name,
                is_leaf: true,
                active: true,
                parent_id: parent.id
              })
              |> Ash.create!(authorize?: false, return_notifications?: true)

            notifications
          end)

        n_parent ++ n_children
      end)
    end
  end

  defp users_exist? do
    User |> Ash.exists?(authorize?: false)
  end
end
