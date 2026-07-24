defmodule SynieWeb.AuthzMatrix.World do
  @moduledoc """
  权限矩阵的「双公司夹具世界」:公司甲/乙 + 每资源构造函数注册表 + 应得集声明。

  ## 物理落点(umbrella 皱褶)

  umbrella 下 synie_core 的 test/support 不参与 synie_web 的编译,反向把 core 的
  support 目录挂进 web 的 elixirc_paths 会把同一模块编译进两个 app 产生冲突。
  故世界构造器整体落在 synie_web/test/support(web 依赖 core,能直接建 core 记录),
  少量小夹具(公司/币种)与 core 的 AuthzFixtures 重复,属有意取舍。

  ## 两段构建

  `build!/0` 先建「标准数据上下文」ctx(公司甲乙、世界币种/单位、默认存储、
  世界文件、行情品种等被跨资源引用的记录,显式依赖顺序),再跑构造函数注册表。
  构造函数之间不允许互相依赖(注册表是无序 map)——凡被别的资源引用的记录
  一律进 ctx,由对应资源的构造函数「认领」返回。

  ## 构造函数契约

  - 每个进权限目录的资源在 `builders/0` 登记一个构造函数;
  - 构造函数收 ctx,以 `authorize?: false` 建数(受信内部路径,与既有 domain
    fixtures 同款);
  - 公司隔离资源在甲乙两司**各建一条**合法记录;全局资源建一条;
  - 必须返回**本资源本次创建(或认领)的全部记录**——应得集 oracle 与
    super_admin「恰好看到全部」断言都以返回值为准,漏登记会直接把矩阵断红。
    特例:sys_setting 单行由迁移种入(资源不开放 create),构造函数认领该种子行。

  ## 写输入契约(工单03扩展)

  凡已覆盖资源在 GraphQL 注册了通用 create/update mutation(动作名与类型同名,
  见 `Gql.primary_mutation_fields/1`),`write_inputs/1` 必须给出对应输入
  (完整性守卫强制):

  - `create`:`(公司) -> GraphQL input map`,产出**在该公司下合法可建**的输入
    ——跨公司 create 负向与写侧正向对照都复用它(全局资源忽略公司参数);
  - `update`:`() -> GraphQL input map`,一个良性字段变更(改他司负向与正向对照复用)。

  `write_inputs/1` 收 ctx,输入函数**只在闭包内**引用 ctx(完整性守卫以占位
  空 map 调用本函数查键,构建 map 字面量不得触碰 ctx)。枚举值用
  `{:enum, "DEBIT"}` 标记。

  ## 应得集声明(expected-visibility)

  默认规则:带 `company_id` 的资源「公司匹配即应得」(`:company`),
  无公司字段的资源「有码即读」(`:global`)。特例以 `visibility/1` 的资源专属
  函数头显式声明 `{:custom, fun}`(fun 收记录与生效公司集),矩阵断言循环
  只消费声明,不硬编码特例。现有特例:

  - 审计日志:无公司行放行 + 公司匹配(系统级操作日志人人可查,业务操作随公司)。

  ## 共享资源(世界外行的来源声明)

  多数资源的世界记录就是测试库中的全部行(独占),list 扫描不加过滤,
  「恰好等于+count」顺带证明世界之外无多余可见行。`shared/0` 里的资源
  测试库中存在世界之外的行(理由见表),其 list 扫描降为 id 定界查询
  (`Gql.bounded_list_query/2`),断言口径不变;写矩阵的世界不变式同理定界。

  ## 覆盖豁免清单

  权限目录内还没有构造函数的资源必须在 `coverage_exempt/0` 挂名并写明理由
  (完整性守卫 diff 目录与本表,缺席即红)。批次工单(05-07)落地一个删一个,
  收口工单(10)清零。

  ## 已知覆盖缺口(记档)

  - sys.file 只注册了 destroy mutation 且无 create 写输入可正向对照,
    其 destroy 正向暂缺(全拒假绿风险有界);文件字节出口的正反向场景
    归 R3 出口工单(08)。
  """

  alias SynieCore.Authz.Registry

  @template_path Path.expand("../fixtures/matrix_template.xlsx", __DIR__)

  # ── 构造函数注册表 ────────────────────────────────────────────────────────

  @doc "资源模块 => 构造函数。构造函数返回该资源创建(或认领)的全部记录。"
  def builders do
    %{
      # sys(批次A)
      SynieCore.Accounts.User => &build_users/1,
      SynieCore.Authz.Role => &build_roles/1,
      SynieCore.Authz.RolePermission => &build_role_permissions/1,
      SynieCore.Audit.Log => &build_audit_logs/1,
      SynieCore.Files.File => &build_files/1,
      SynieCore.Files.StorageEndpoint => &build_storages/1,
      SynieCore.Numbering.Rule => &build_numbering_rules/1,
      SynieCore.Printing.Template => &build_print_templates/1,
      SynieCore.Sys.Setting => &build_sys_settings/1,
      # base(批次A)
      SynieCore.Base.Company => &build_companies/1,
      SynieCore.Base.Unit => &build_units/1,
      SynieCore.Base.Currency => &build_currencies/1,
      SynieCore.Base.Account => &build_bas_accounts/1,
      SynieCore.Base.MarketInstrument => &build_market_instruments/1,
      SynieCore.Base.MarketPricePoint => &build_market_prices/1,
      # 试点(工单02)
      SynieCore.Acc.GlJournal => &build_gl_journals/1,
      SynieCore.Inv.Warehouse => &build_warehouses/1
    }
  end

  @doc "已覆盖资源的权限前缀集合。"
  def covered_prefixes, do: builders() |> Map.keys() |> Enum.map(& &1.permission_prefix())

  # ── 共享资源声明 ──────────────────────────────────────────────────────────

  @doc "测试库中存在世界之外行的资源 => 来源理由。扫描语义见 moduledoc。"
  def shared do
    %{
      SynieCore.Accounts.User => "合成极值主体本身就是 sys_user 行",
      SynieCore.Authz.Role => "合成主体的角色行 + 迁移种子内置 admin 角色",
      SynieCore.Authz.RolePermission => "合成主体的授权行 + 内置 admin 的通配授权种子",
      SynieCore.Audit.Log => "世界建数与主体夹具的审计副产物",
      SynieCore.Base.Currency => "迁移种子(CNY)",
      SynieCore.Base.Unit => "迁移种子(克/千克)",
      SynieCore.Base.MarketInstrument => "迁移种子(沪铜等预置品种)"
    }
  end

  @doc "该资源的 list 扫描是否须 id 定界(存在世界外行)。"
  def shared?(module), do: Map.has_key?(shared(), module)

  # ── 写输入注册表 ──────────────────────────────────────────────────────────

  @doc """
  写输入注册表(契约见 moduledoc):资源模块 => %{create: (公司 -> input), update: (-> input)}。
  input 键用 GraphQL camelCase 字段名。
  """
  def write_inputs(ctx) do
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
      },
      # sys.user 无通用 create mutation(建用户走专有动线),仅良性 update
      SynieCore.Accounts.User => %{
        update: fn -> %{"name" => "矩阵用户改名-#{System.unique_integer([:positive])}"} end
      },
      SynieCore.Authz.Role => %{
        create: fn _company ->
          %{"code" => "mxw_#{System.unique_integer([:positive])}", "name" => "矩阵写角色"}
        end,
        update: fn -> %{"name" => "矩阵写角色-改名-#{System.unique_integer([:positive])}"} end
      },
      SynieCore.Authz.RolePermission => %{
        create: fn _company ->
          %{"roleId" => ctx.role.id, "permission" => "base.unit:read"}
        end
      },
      SynieCore.Files.StorageEndpoint => %{
        create: fn _company ->
          suffix = System.unique_integer([:positive])
          root = Path.join(ctx.storage_root, "w#{suffix}")
          File.mkdir_p!(root)

          %{
            "name" => "mxw_#{suffix}",
            "label" => "矩阵写存储",
            "kind" => {:enum, "LOCAL"},
            "root" => root
          }
        end,
        update: fn -> %{"label" => "矩阵写存储-改名-#{System.unique_integer([:positive])}"} end
      },
      SynieCore.Numbering.Rule => %{
        create: fn _company ->
          %{
            "resource" => "sales.order",
            "name" => "矩阵写编号-#{System.unique_integer([:positive])}",
            # {:array, :map} + json_string 的不对称契约:输入是「JSON 串的数组」
            "segments" => [
              ~s|{"type":"text","value":"MXW"}|,
              ~s|{"type":"seq","padding":4}|
            ],
            "perCompany" => false,
            "enabled" => false
          }
        end,
        update: fn -> %{"name" => "矩阵写编号-改名-#{System.unique_integer([:positive])}"} end
      },
      SynieCore.Printing.Template => %{
        create: fn _company ->
          %{
            "name" => "矩阵写模板-#{System.unique_integer([:positive])}",
            "resource" => "sales.order",
            "fileId" => ctx.template_file.id
          }
        end,
        update: fn -> %{"name" => "矩阵写模板-改名-#{System.unique_integer([:positive])}"} end
      },
      SynieCore.Sys.Setting => %{
        update: fn -> %{"marketFetchLastIntervalMinutes" => 60} end
      },
      SynieCore.Base.Company => %{
        create: fn _company ->
          suffix = System.unique_integer([:positive])
          # 公司代码限两位字母;首字母固定 w/x,避开世界公司 ja/yi
          code = <<?w + rem(div(suffix, 26), 2), ?a + rem(suffix, 26)>>

          %{
            "code" => code,
            "name" => "矩阵写公司#{suffix}",
            "shortName" => "矩写#{suffix}",
            "baseCurrencyId" => ctx.cny.id
          }
        end,
        update: fn -> %{"name" => "矩阵写公司-改名-#{System.unique_integer([:positive])}"} end
      },
      SynieCore.Base.Unit => %{
        create: fn _company ->
          suffix = System.unique_integer([:positive])

          %{
            "unitType" => {:enum, "WEIGHT"},
            "name" => "矩阵写单位#{suffix}",
            "symbol" => "mw#{suffix}",
            "ratio" => 1
          }
        end,
        update: fn -> %{"name" => "矩阵写单位-改名-#{System.unique_integer([:positive])}"} end
      },
      SynieCore.Base.Currency => %{
        create: fn _company ->
          suffix = System.unique_integer([:positive])
          # ISO 码限三位大写;首字母固定 W,避开种子 CNY 与世界 USD
          iso = <<?W, ?A + rem(suffix, 26), ?A + rem(div(suffix, 26), 26)>>

          %{
            "name" => "矩阵写币-#{suffix}",
            "isoCode" => iso
          }
        end,
        update: fn -> %{"name" => "矩阵写币-改名-#{System.unique_integer([:positive])}"} end
      },
      SynieCore.Base.Account => %{
        create: fn company ->
          %{
            "companyId" => company.id,
            "code" => "MXW#{System.unique_integer([:positive])}",
            "name" => "矩阵写科目",
            "direction" => {:enum, "DEBIT"}
          }
        end,
        update: fn -> %{"name" => "矩阵写科目-改名-#{System.unique_integer([:positive])}"} end
      },
      SynieCore.Base.MarketInstrument => %{
        create: fn _company ->
          %{
            "code" => "MXI#{System.unique_integer([:positive])}",
            "name" => "矩阵写品种",
            "sourceType" => {:enum, "SPOT_INDEX"},
            "defaultPriceKind" => {:enum, "SETTLEMENT"},
            "currencyId" => ctx.currency.id,
            "unitId" => ctx.unit.id
          }
        end,
        update: fn -> %{"name" => "矩阵写品种-改名-#{System.unique_integer([:positive])}"} end
      },
      SynieCore.Base.MarketPricePoint => %{
        create: fn _company ->
          %{
            "instrumentId" => ctx.instrument.id,
            "observedAt" => "2026-07-02T03:00:00Z",
            "price" => "1234.5",
            "priceKind" => {:enum, "SETTLEMENT"}
          }
        end
      }
    }
  end

  # ── 应得集声明 ────────────────────────────────────────────────────────────

  @doc """
  资源的应得集声明。默认规则:有 company_id 按公司匹配(:company),否则全局有码即读(:global)。
  特例由默认子句上方的资源专属函数头声明 {:custom, fun}(见 moduledoc)。
  """
  # 审计日志:无公司行放行(系统级操作),有公司行按公司匹配
  def visibility(SynieCore.Audit.Log), do: {:custom, &audit_log_visible?/2}

  def visibility(module) do
    if Ash.Resource.Info.attribute(module, :company_id), do: :company, else: :global
  end

  defp audit_log_visible?(record, effective_companies) do
    is_nil(record.company_id) or effective_companies == :all or
      record.company_id in effective_companies
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
      case visibility(module) do
        :company -> effective_companies == :all or record.company_id in effective_companies
        :global -> true
        {:custom, fun} -> fun.(record, effective_companies)
      end
    end)
    |> MapSet.new(& &1.id)
  end

  # ── 覆盖豁免清单(expand–contract:批次工单逐批清空,不允许无理由豁免)──

  @batch_b "夹具构造函数随批次B(工单05:acc)落地"
  @batch_c "夹具构造函数随批次C(工单06:hr+inv+mfg)落地"
  @batch_d "夹具构造函数随批次D(工单07:sales+purchase)落地"

  @doc "世界覆盖豁免:权限前缀 => 理由。"
  def coverage_exempt do
    %{
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
  读矩阵经 `Gql.read_endpoint!/1` 的回落分支照常覆盖。
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
  构建双公司世界:标准数据 ctx + 全部已注册资源的记录。
  调用方负责 Sandbox 事务(整世界随事务回滚,不落测试库),并在退出时
  `File.rm_rf!(world.storage_root)` 清理世界存储目录。
  """
  def build! do
    ctx = base_ctx()
    records = Map.new(builders(), fn {module, builder} -> {module, builder.(ctx)} end)

    %{
      company_a: ctx.company_a,
      company_b: ctx.company_b,
      storage_root: ctx.storage_root,
      ctx: ctx,
      records: records
    }
  end

  @doc "目录中该前缀对应的资源模块。"
  def catalog_module!(prefix), do: Map.fetch!(Registry.resource_modules(), prefix)

  # ── 标准数据 ctx(显式依赖顺序;被跨资源引用的记录都在这里)──────────────

  defp base_ctx do
    storage_root =
      Path.join(System.tmp_dir!(), "synie_mx_world_#{System.unique_integer([:positive])}")

    File.mkdir_p!(storage_root)

    cny = cny!()
    currency = currency!("矩阵美元", "USD")
    unit = unit!("矩阵吨", "mxt")
    company_a = company!("ja", "矩阵甲公司", cny)
    company_b = company!("yi", "矩阵乙公司", cny)
    storage = storage!(storage_root)
    user = user!("mx_world_#{System.unique_integer([:positive])}")
    role = role!("mx_world_#{System.unique_integer([:positive])}")
    bare_file = file!(storage, storage_root, "矩阵裸文件.txt", "MX 裸文件字节", user)

    template_file =
      file!(storage, storage_root, "matrix_template.xlsx", File.read!(@template_path), user)

    instrument = instrument!(currency, unit)

    %{
      storage_root: storage_root,
      cny: cny,
      currency: currency,
      unit: unit,
      company_a: company_a,
      company_b: company_b,
      storage: storage,
      user: user,
      role: role,
      bare_file: bare_file,
      template_file: template_file,
      instrument: instrument
    }
  end

  # ── 基础夹具(与 synie_core 的 AuthzFixtures 少量重复,见 moduledoc)────

  defp company!(code, name, currency) do
    SynieCore.Base.Company
    |> Ash.Changeset.for_create(:create, %{
      code: code,
      name: name,
      short_name: name,
      base_currency_id: currency.id
    })
    |> Ash.create!(authorize?: false)
  end

  # CNY 由迁移种入,取或建(与 file_controller_test 同款兜底)
  defp cny! do
    case Ash.get(SynieCore.Base.Currency, %{iso_code: "CNY"}, authorize?: false, error?: false) do
      {:ok, %{id: _} = currency} -> currency
      _missing -> currency!("人民币", "CNY")
    end
  end

  defp currency!(name, iso_code) do
    SynieCore.Base.Currency
    |> Ash.Changeset.for_create(:create, %{name: name, iso_code: iso_code})
    |> Ash.create!(authorize?: false)
  end

  defp unit!(name, symbol) do
    SynieCore.Base.Unit
    |> Ash.Changeset.for_create(:create, %{
      unit_type: :weight,
      name: name,
      symbol: symbol,
      ratio: 1
    })
    |> Ash.create!(authorize?: false)
  end

  defp storage!(root) do
    SynieCore.Files.StorageEndpoint
    |> Ash.Changeset.for_create(:create, %{
      name: "mx_local",
      label: "矩阵本地存储",
      kind: :local,
      root: Path.join(root, "objects")
    })
    |> Ash.Changeset.force_change_attribute(:is_default, true)
    |> Ash.create!(authorize?: false)
  end

  defp user!(username) do
    SynieCore.Accounts.User
    |> Ash.Changeset.for_create(:create, %{username: username, password: "secret123"})
    |> Ash.create!(authorize?: false)
  end

  defp role!(code) do
    SynieCore.Authz.Role
    |> Ash.Changeset.for_create(:create, %{code: code, name: "矩阵世界角色"})
    |> Ash.create!(authorize?: false)
  end

  # 世界文件:字节真实落存储(打印模板创建会回读文件校验占位符)
  defp file!(storage, root, filename, bytes, uploader) do
    src = Path.join(root, "src_#{System.unique_integer([:positive])}")
    File.write!(src, bytes)
    key = "mx/#{System.unique_integer([:positive])}/#{filename}"
    :ok = SynieCore.Storage.put(storage.name, key, src)

    SynieCore.Files.File
    |> Ash.Changeset.for_create(:create, %{
      storage: storage.name,
      key: key,
      filename: filename,
      size: byte_size(bytes),
      uploaded_by_id: uploader.id
    })
    |> Ash.create!(authorize?: false)
  end

  defp instrument!(currency, unit) do
    SynieCore.Base.MarketInstrument
    |> Ash.Changeset.for_create(:create, %{
      code: "MXI-#{System.unique_integer([:positive])}",
      name: "矩阵品种",
      source_type: :spot_index,
      default_price_kind: :settlement,
      currency_id: currency.id,
      unit_id: unit.id
    })
    |> Ash.create!(authorize?: false)
  end

  # ── 构造函数:sys ─────────────────────────────────────────────────────────

  defp build_users(%{user: user}), do: [user]

  defp build_roles(%{role: role}), do: [role]

  defp build_role_permissions(%{role: role}) do
    [
      SynieCore.Authz.RolePermission
      |> Ash.Changeset.for_create(:create, %{role_id: role.id, permission: "base.currency:read"})
      |> Ash.create!(authorize?: false)
    ]
  end

  # 审计日志:经内部 :record 动作建三行——甲司/乙司/无公司(系统级),
  # 覆盖 custom 应得集的三种取值
  defp build_audit_logs(%{company_a: a, company_b: b}) do
    for company_id <- [a.id, b.id, nil] do
      SynieCore.Audit.Log
      |> Ash.Changeset.for_create(:record, %{
        resource: "authz_matrix",
        record_id: Ash.UUID.generate(),
        record_label: "矩阵审计样本",
        action_type: "update",
        action_name: "update",
        company_id: company_id,
        changes: %{}
      })
      |> Ash.create!(authorize?: false)
    end
  end

  defp build_files(%{bare_file: bare, template_file: template}), do: [bare, template]

  defp build_storages(%{storage: storage}), do: [storage]

  defp build_numbering_rules(_ctx) do
    [
      SynieCore.Numbering.Rule
      |> Ash.Changeset.for_create(:create, %{
        resource: "acc.gl_journal",
        name: "矩阵世界编号规则",
        segments: [
          %{"type" => "text", "value" => "MX"},
          %{"type" => "seq", "padding" => 4}
        ],
        per_company: false
      })
      |> Ash.create!(authorize?: false)
    ]
  end

  defp build_print_templates(%{template_file: template_file}) do
    [
      SynieCore.Printing.Template
      |> Ash.Changeset.for_create(:create, %{
        name: "矩阵世界模板",
        resource: "sales.order",
        file_id: template_file.id
      })
      |> Ash.create!(authorize?: false)
    ]
  end

  # sys_setting 单行由迁移种入且资源不开放 create,认领种子行
  defp build_sys_settings(_ctx), do: [SynieCore.Sys.Setting.get()]

  # ── 构造函数:base ────────────────────────────────────────────────────────

  defp build_companies(%{company_a: a, company_b: b}), do: [a, b]

  defp build_units(%{unit: unit}), do: [unit]

  defp build_currencies(%{currency: currency}), do: [currency]

  defp build_bas_accounts(%{company_a: a, company_b: b}) do
    for company <- [a, b] do
      SynieCore.Base.Account
      |> Ash.Changeset.for_create(:create, %{
        code: "MX01",
        name: "矩阵科目-#{company.code}",
        direction: :debit,
        company_id: company.id
      })
      |> Ash.create!(authorize?: false)
    end
  end

  defp build_market_instruments(%{instrument: instrument}), do: [instrument]

  defp build_market_prices(%{instrument: instrument}) do
    [
      SynieCore.Base.MarketPricePoint
      |> Ash.Changeset.for_create(:create, %{
        instrument_id: instrument.id,
        observed_at: ~U[2026-07-01 03:00:00Z],
        price: Decimal.new("1000.5"),
        price_kind: :settlement
      })
      |> Ash.create!(authorize?: false)
    ]
  end

  # ── 构造函数:试点 ────────────────────────────────────────────────────────

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
