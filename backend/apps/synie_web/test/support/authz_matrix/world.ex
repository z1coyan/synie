defmodule SynieWeb.AuthzMatrix.World do
  @moduledoc """
  权限矩阵的「双公司夹具世界」:公司甲/乙 + 每资源构造函数注册表 + 应得集声明。

  ## 物理落点(umbrella 皱褶)

  umbrella 下 synie_core 的 test/support 不参与 synie_web 的编译,反向把 core 的
  support 目录挂进 web 的 elixirc_paths 会把同一模块编译进两个 app 产生冲突。
  故世界构造器整体落在 synie_web/test/support(web 依赖 core,能直接建 core 记录),
  少量小夹具(公司/币种)与 core 的 AuthzFixtures 重复,属有意取舍。

  ## 构造函数契约

  - 每个进权限目录的资源在 `builders/0` 登记一个构造函数;
  - 构造函数收 `%{company_a: 公司, company_b: 公司}`,以 `authorize?: false` 建数
    (受信内部路径,与既有 domain fixtures 同款);
  - 公司隔离资源在甲乙两司**各建一条**合法记录;全局资源建一条;
  - 必须返回**本资源本次创建的全部记录**——应得集 oracle 与 super_admin
    「恰好看到全部」断言都以返回值为准,漏登记会直接把矩阵断红。

  ## 写输入契约(工单03扩展)

  凡已覆盖资源在 GraphQL 注册了 create/update mutation,`write_inputs/0` 必须给出
  对应输入(完整性守卫强制):

  - `create`:`(公司) -> GraphQL input map`,产出**在该公司下合法可建**的输入
    ——跨公司 create 负向与写侧正向对照都复用它;
  - `update`:`() -> GraphQL input map`,一个良性字段变更(改他司负向与正向对照复用)。

  写矩阵对每个有 write_inputs 的资源自动跑正向对照(甲司 create→update→destroy,
  净零不扰动世界);状态机复杂到正向走不通的资源,由对应批次工单在此契约上再议。

  ## 应得集声明(expected-visibility)

  默认规则:带 `company_id` 的资源「公司匹配即应得」(`:company`),
  无公司字段的资源「有码即读」(`:global`)。特例(裸文件仅上传者、审计日志
  无公司行放行等)以 `visibility/1` 的资源专属函数头显式声明(写法见其 @doc;
  首个 {:custom, fun} 特例落地时同步在 `expected_ids/3` 启用 custom 分支),
  矩阵断言循环只消费声明,不硬编码特例。

  ## 覆盖豁免清单

  权限目录内还没有构造函数的资源必须在 `coverage_exempt/0` 挂名并写明理由
  (完整性守卫 diff 目录与本表,缺席即红)。批次工单(04-07)落地一个删一个,
  收口工单(10)清零。
  """

  alias SynieCore.Authz.Registry

  # ── 构造函数注册表(试点:acc.gl_journal 与 inv.warehouse)──────────────

  @doc "资源模块 => 构造函数。构造函数返回该资源创建的全部记录。"
  def builders do
    %{
      SynieCore.Acc.GlJournal => &build_gl_journals/1,
      SynieCore.Inv.Warehouse => &build_warehouses/1
    }
  end

  @doc "已覆盖资源的权限前缀集合。"
  def covered_prefixes, do: builders() |> Map.keys() |> Enum.map(& &1.permission_prefix())

  @doc """
  写输入注册表(契约见 moduledoc):资源模块 => %{create: (公司 -> input), update: (-> input)}。
  input 键用 GraphQL camelCase 字段名。
  """
  def write_inputs do
    %{
      SynieCore.Acc.GlJournal => %{
        create: fn company ->
          %{
            "companyId" => company.id,
            "voucherNo" => "MXW-#{company.code}-#{System.unique_integer([:positive])}",
            "date" => "2026-07-02"
          }
        end,
        update: fn -> %{"remarks" => "矩阵写侧改动"} end
      },
      SynieCore.Inv.Warehouse => %{
        create: fn company ->
          %{
            "name" => "矩阵写仓-#{System.unique_integer([:positive])}",
            "companyId" => company.id
          }
        end,
        update: fn -> %{"name" => "矩阵写仓-改名-#{System.unique_integer([:positive])}"} end
      }
    }
  end

  # ── 应得集声明 ────────────────────────────────────────────────────────────

  @doc """
  资源的应得集声明。默认规则:有 company_id 按公司匹配(:company),否则全局有码即读(:global)。

  特例(裸文件仅上传者、审计日志无公司行放行等)由批次工单在默认子句**上方**加资源专属
  函数头声明,如:`def visibility(SynieCore.Files.File), do: {:custom, &file_visible?/2}`,
  并在 `expected_ids/3` 补 {:custom, fun} 分支。
  """
  def visibility(module) do
    if Ash.Resource.Info.attribute(module, :company_id), do: :company, else: :global
  end

  @doc """
  应得集 oracle:主体(以其生效公司集表达)在该资源上应当恰好看到的世界记录 id 集。

  `effective_companies` 为 `:all`(all_companies/super_admin)或公司 id 列表。
  只解释声明,不重新实现服务端过滤逻辑。
  """
  def expected_ids(world, module, effective_companies) do
    world.records
    |> Map.fetch!(module)
    |> Enum.filter(fn record ->
      # 首个 {:custom, fun} 特例声明落地时,在此补分支:fun.(record, effective_companies)
      # (现在写上会因 override 全空被编译器判死子句)
      case visibility(module) do
        :company -> effective_companies == :all or record.company_id in effective_companies
        :global -> true
      end
    end)
    |> MapSet.new(& &1.id)
  end

  # ── 覆盖豁免清单(expand–contract:批次工单逐批清空,不允许无理由豁免)──

  @batch_a "夹具构造函数随批次A(工单04:sys+base)落地"
  @batch_b "夹具构造函数随批次B(工单05:acc)落地"
  @batch_c "夹具构造函数随批次C(工单06:hr+inv+mfg)落地"
  @batch_d "夹具构造函数随批次D(工单07:sales+purchase)落地"

  @doc "世界覆盖豁免:权限前缀 => 理由。"
  def coverage_exempt do
    %{
      "sys.user" => @batch_a,
      "sys.role" => @batch_a,
      "sys.role_permission" => @batch_a,
      "sys.audit_log" => @batch_a,
      "sys.file" => @batch_a,
      "sys.storage" => @batch_a,
      "sys.numbering_rule" => @batch_a,
      "sys.print_template" => @batch_a,
      "sys.setting" => @batch_a,
      "base.company" => @batch_a,
      "base.unit" => @batch_a,
      "base.currency" => @batch_a,
      "base.account" => @batch_a,
      "base.market_instrument" => @batch_a,
      "base.market_price" => @batch_a,
      "acc.bank_account" => @batch_b,
      "acc.bank_import_template" => @batch_b,
      "acc.bank_transaction" => @batch_b,
      "acc.bill" => @batch_b,
      "acc.bill_holding" => @batch_b,
      "acc.bill_transaction" => @batch_b,
      "acc.expense_report" => @batch_b,
      "acc.gl_entry" => @batch_b,
      "acc.setting" => @batch_b,
      "acc.vat_invoice" => @batch_b,
      "hr.attendance_correction" => @batch_c,
      "hr.attendance_day" => @batch_c,
      "hr.attendance_punch" => @batch_c,
      "hr.employee" => @batch_c,
      "hr.employee_loan" => @batch_c,
      "hr.payroll" => @batch_c,
      "hr.payroll_payment" => @batch_c,
      "inv.material" => @batch_c,
      "inv.material_category" => @batch_c,
      "inv.stock_count" => @batch_c,
      "inv.stock_doc" => @batch_c,
      "inv.stock_entry" => @batch_c,
      "inv.stock_transfer" => @batch_c,
      "mfg.bom" => @batch_c,
      "mfg.operation" => @batch_c,
      "mfg.route_template" => @batch_c,
      "sales.customer" => @batch_d,
      "sales.delivery" => @batch_d,
      "sales.order" => @batch_d,
      "sales.quotation" => @batch_d,
      "sales.reconciliation" => @batch_d,
      "sales.setting" => @batch_d,
      "purchase.order" => @batch_d,
      "purchase.quotation" => @batch_d,
      "purchase.receipt" => @batch_d,
      "purchase.reconciliation" => @batch_d,
      "purchase.supplier" => @batch_d
    }
  end

  @doc """
  「声明 read 必在表格元数据白名单」守卫的豁免:权限前缀 => 理由。
  这些资源有 read 权限点但没有表格页,读出口另有形态(read_one 单行查询/权限矩阵面板),
  仍会经世界覆盖进入读矩阵(见各批次工单)。
  """
  def whitelist_exempt do
    %{
      "sys.role_permission" => "授权行没有独立表格页,读面是角色权限矩阵面板(list 查询 sysRolePermissions);读矩阵经批次A覆盖",
      "sys.setting" => "系统设置单行表,read_one 查询(sysSetting),无表格页;读矩阵经批次A覆盖",
      "acc.setting" => "财务设置单行表,read_one 查询(accSetting),无表格页;读矩阵经批次B覆盖",
      "sales.setting" => "供应链设置单行表,read_one 查询(salSetting),无表格页;读矩阵经批次D覆盖"
    }
  end

  # ── 世界构建 ────────────────────────────────────────────────────────────

  @doc """
  构建双公司世界:公司甲/乙 + 全部已注册资源的记录。
  调用方负责 Sandbox 事务(整世界随事务回滚,不落测试库)。
  """
  def build! do
    company_a = company!("ja", "矩阵甲公司")
    company_b = company!("yi", "矩阵乙公司")
    ctx = %{company_a: company_a, company_b: company_b}

    records = Map.new(builders(), fn {module, builder} -> {module, builder.(ctx)} end)

    %{company_a: company_a, company_b: company_b, records: records}
  end

  @doc "目录中该前缀对应的资源模块。"
  def catalog_module!(prefix), do: Map.fetch!(Registry.resource_modules(), prefix)

  # ── 基础夹具(与 synie_core 的 AuthzFixtures 少量重复,见 moduledoc)────

  defp company!(code, name) do
    SynieCore.Base.Company
    |> Ash.Changeset.for_create(:create, %{
      code: code,
      name: name,
      short_name: name,
      base_currency_id: cny_id!()
    })
    |> Ash.create!(authorize?: false)
  end

  # CNY 由迁移种入,取或建(与 file_controller_test 同款兜底)
  defp cny_id! do
    case Ash.get(SynieCore.Base.Currency, %{iso_code: "CNY"}, authorize?: false, error?: false) do
      {:ok, %{id: id}} when is_binary(id) ->
        id

      _missing ->
        SynieCore.Base.Currency
        |> Ash.Changeset.for_create(:create, %{name: "人民币", iso_code: "CNY", symbol: "￥"})
        |> Ash.create!(authorize?: false)
        |> Map.fetch!(:id)
    end
  end

  # ── 试点构造函数 ──────────────────────────────────────────────────────────

  defp build_gl_journals(%{company_a: a, company_b: b}) do
    for company <- [a, b] do
      SynieCore.Acc.GlJournal
      |> Ash.Changeset.for_create(:create, %{
        company_id: company.id,
        voucher_no: "MX-#{company.code}-#{System.unique_integer([:positive])}",
        date: ~D[2026-07-01]
      })
      |> Ash.create!(authorize?: false)
    end
  end

  defp build_warehouses(%{company_a: a, company_b: b}) do
    for company <- [a, b] do
      SynieCore.Inv.Warehouse
      |> Ash.Changeset.for_create(:create, %{
        name: "矩阵仓-#{company.code}",
        company_id: company.id
      })
      |> Ash.create!(authorize?: false)
    end
  end
end
