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

  - 审计日志:无公司行放行 + 公司匹配(系统级操作日志人人可查,业务操作随公司);
  - 票据(acc.bill):全局票据实体随交易可见——任一笔本司交易触达的票据即应得
    (构造函数返回**预载 transactions** 的票据,oracle 不回库查询)。

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
      # acc(批次B)
      SynieCore.Acc.BankAccount => &build_bank_accounts/1,
      SynieCore.Acc.BankImportTemplate => &build_bank_import_templates/1,
      SynieCore.Acc.BankTransaction => &build_bank_transactions/1,
      SynieCore.Acc.Bill => &build_bills/1,
      SynieCore.Acc.BillHolding => &build_bill_holdings/1,
      SynieCore.Acc.BillTransaction => &build_bill_transactions/1,
      SynieCore.Acc.ExpenseReport => &build_expense_reports/1,
      SynieCore.Acc.GlEntry => &build_gl_entries/1,
      SynieCore.Acc.Setting => &build_acc_settings/1,
      SynieCore.Acc.VatInvoice => &build_vat_invoices/1,
      # hr(批次C)
      SynieCore.Hr.Employee => &build_employees/1,
      SynieCore.Hr.AttendancePunch => &build_attendance_punches/1,
      SynieCore.Hr.AttendanceDay => &build_attendance_days/1,
      SynieCore.Hr.AttendanceCorrection => &build_attendance_corrections/1,
      SynieCore.Hr.EmployeeLoan => &build_employee_loans/1,
      SynieCore.Hr.Payroll => &build_payrolls/1,
      SynieCore.Hr.PayrollPayment => &build_payroll_payments/1,
      # inv(批次C)
      SynieCore.Inv.MaterialCategory => &build_material_categories/1,
      SynieCore.Inv.Material => &build_materials/1,
      SynieCore.Inv.StockDoc => &build_stock_docs/1,
      SynieCore.Inv.StockCount => &build_stock_counts/1,
      SynieCore.Inv.StockTransfer => &build_stock_transfers/1,
      SynieCore.Inv.StockEntry => &build_stock_entries/1,
      # mfg(批次C)
      SynieCore.Mfg.Operation => &build_operations/1,
      SynieCore.Mfg.ProcessTemplate => &build_process_templates/1,
      SynieCore.Mfg.Bom => &build_boms/1,
      # sales(批次D)
      SynieCore.Sales.Customer => &build_customers/1,
      SynieCore.Sales.Order => &build_sales_orders/1,
      SynieCore.Sales.Delivery => &build_deliveries/1,
      SynieCore.Sales.Quotation => &build_sales_quotations/1,
      SynieCore.Sales.Reconciliation => &build_sales_reconciliations/1,
      SynieCore.Sales.Setting => &build_sales_settings/1,
      # purchase(批次D)
      SynieCore.Purchase.Supplier => &build_suppliers/1,
      SynieCore.Purchase.Order => &build_purchase_orders/1,
      SynieCore.Purchase.Receipt => &build_receipts/1,
      SynieCore.Purchase.Quotation => &build_purchase_quotations/1,
      SynieCore.Purchase.Reconciliation => &build_purchase_reconciliations/1,
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
      SynieCore.Base.MarketInstrument => "迁移种子(沪铜等预置品种)",
      SynieCore.Hr.AttendanceDay => "考勤修正增删改触发的重算副产物(世界与写侧正向的补卡日避开世界考勤日)"
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
      },
      SynieCore.Acc.BankAccount => %{
        create: fn company ->
          suffix = System.unique_integer([:positive])

          %{
            "alias" => "矩阵写户#{suffix}",
            "bankName" => "矩阵写银行",
            "holderName" => "矩阵写持有人",
            "accountNo" => "88#{suffix}",
            "companyId" => company.id,
            "currencyId" => ctx.cny.id
          }
        end,
        update: fn -> %{"note" => "矩阵写侧改动-#{System.unique_integer([:positive])}"} end
      },
      SynieCore.Acc.BankImportTemplate => %{
        create: fn company ->
          %{
            "name" => "矩阵写模板-#{System.unique_integer([:positive])}",
            "companyId" => company.id,
            "bankAccountId" => bank_account_of(ctx, company).id,
            "datetimeCol" => "A",
            "datetimeFormat" => {:enum, "YMD_DASH_HMS"},
            "amountCol" => "C"
          }
        end,
        update: fn -> %{"name" => "矩阵写模板-改名-#{System.unique_integer([:positive])}"} end
      },
      SynieCore.Acc.BankTransaction => %{
        create: fn company ->
          %{
            "occurredAt" => "2026-07-02T03:00:00Z",
            "income" => "50",
            "companyId" => company.id,
            "bankAccountId" => bank_account_of(ctx, company).id
          }
        end,
        update: fn -> %{"note" => "矩阵写侧改动-#{System.unique_integer([:positive])}"} end
      },
      # 票据不开放通用 create(建档走收票交易),仅良性 update 正向
      SynieCore.Acc.Bill => %{
        update: fn -> %{"remarks" => "矩阵写侧改动-#{System.unique_integer([:positive])}"} end
      },
      SynieCore.Acc.BillTransaction => %{
        create: fn company ->
          %{
            "docNo" => "MXWBT-#{System.unique_integer([:positive])}",
            "transactionType" => {:enum, "RECEIVE"},
            "occurredOn" => "2026-07-02",
            "subStart" => 1,
            "subEnd" => 100,
            "amount" => "1",
            "partyType" => {:enum, "CUSTOMER"},
            "partyId" => ctx.customer.id,
            "companyId" => company.id,
            "bankAccountId" => bank_account_of(ctx, company).id,
            "billId" => bill_of(ctx, company).id
          }
        end,
        update: fn -> %{"remarks" => "矩阵写侧改动-#{System.unique_integer([:positive])}"} end
      },
      SynieCore.Acc.ExpenseReport => %{
        create: fn company ->
          %{
            "companyId" => company.id,
            "docNo" => "MXWBX-#{System.unique_integer([:positive])}",
            "employeeId" => ctx.employee.id,
            "expenseDate" => "2026-07-02",
            "paymentAccountId" => account_of(ctx, company).id
          }
        end,
        update: fn -> %{"remarks" => "矩阵写侧改动-#{System.unique_integer([:positive])}"} end
      },
      SynieCore.Acc.Setting => %{
        update: fn -> %{"ocrAccessKeyId" => "mx-#{System.unique_integer([:positive])}"} end
      },
      SynieCore.Acc.VatInvoice => %{
        create: fn company ->
          %{
            "companyId" => company.id,
            "docNo" => "MXWFP-#{System.unique_integer([:positive])}",
            "direction" => {:enum, "INBOUND"},
            "partyType" => {:enum, "EMPLOYEE"},
            "partyId" => ctx.employee.id,
            "invoiceKind" => {:enum, "NORMAL"}
          }
        end,
        update: fn -> %{"remarks" => "矩阵写侧改动-#{System.unique_integer([:positive])}"} end
      },
      SynieCore.Hr.Employee => %{
        create: fn _company ->
          %{
            "code" => "MXWE#{System.unique_integer([:positive])}",
            "name" => "矩阵写员工"
          }
        end,
        update: fn -> %{"name" => "矩阵写员工-改名-#{System.unique_integer([:positive])}"} end
      },
      # 补卡日避开世界考勤日(2026-07-01)与世界补卡日(2026-07-03),防重算互扰
      SynieCore.Hr.AttendanceCorrection => %{
        create: fn _company ->
          %{
            "employeeId" => ctx.employee.id,
            "date" => "2026-07-04",
            "times" => ["08:00:00"]
          }
        end,
        update: fn -> %{"note" => "矩阵写侧改动-#{System.unique_integer([:positive])}"} end
      },
      SynieCore.Hr.EmployeeLoan => %{
        create: fn _company ->
          %{
            "employeeId" => ctx.employee.id,
            "kind" => {:enum, "BORROW"},
            "occurredOn" => "2026-07-02",
            "amount" => "10"
          }
        end,
        update: fn -> %{"remarks" => "矩阵写侧改动-#{System.unique_integer([:positive])}"} end
      },
      SynieCore.Hr.Payroll => %{
        create: fn _company ->
          %{"employeeId" => ctx.employee.id, "month" => "2026-05"}
        end,
        update: fn -> %{"remarks" => "矩阵写侧改动-#{System.unique_integer([:positive])}"} end
      },
      # 发放行不可改只可删重录(无通用 update);正向 create 会翻转世界工资单
      # 为已发放,destroy 翻回,净零
      SynieCore.Hr.PayrollPayment => %{
        create: fn _company ->
          %{"payrollId" => ctx.payroll.id, "paidOn" => "2026-07-06", "amount" => "1"}
        end
      },
      SynieCore.Inv.MaterialCategory => %{
        create: fn _company ->
          %{
            "code" => "MXW#{System.unique_integer([:positive])}",
            "name" => "矩阵写分类"
          }
        end,
        update: fn -> %{"name" => "矩阵写分类-改名-#{System.unique_integer([:positive])}"} end
      },
      SynieCore.Inv.Material => %{
        create: fn _company ->
          %{
            "name" => "矩阵写物料-#{System.unique_integer([:positive])}",
            "categoryId" => ctx.category.id,
            "defaultUnitId" => ctx.unit.id
          }
        end,
        update: fn -> %{"name" => "矩阵写物料-改名-#{System.unique_integer([:positive])}"} end
      },
      SynieCore.Inv.StockDoc => %{
        create: fn company ->
          %{
            "companyId" => company.id,
            "docNo" => "MXWCRK-#{System.unique_integer([:positive])}",
            "direction" => {:enum, "IN"},
            "warehouseId" => warehouse_of(ctx, company).id
          }
        end,
        update: fn -> %{"remarks" => "矩阵写侧改动-#{System.unique_integer([:positive])}"} end
      },
      SynieCore.Inv.StockCount => %{
        create: fn company ->
          %{
            "companyId" => company.id,
            "docNo" => "MXWPD-#{System.unique_integer([:positive])}",
            "warehouseId" => warehouse_of(ctx, company).id,
            "postingDate" => "2026-07-02"
          }
        end,
        update: fn -> %{"remarks" => "矩阵写侧改动-#{System.unique_integer([:positive])}"} end
      },
      SynieCore.Inv.StockTransfer => %{
        create: fn company ->
          [wh1, wh2, wh3] = warehouses_of(ctx, company)

          %{
            "companyId" => company.id,
            "docNo" => "MXWDB-#{System.unique_integer([:positive])}",
            "fromWarehouseId" => wh1.id,
            "toWarehouseId" => wh2.id,
            "transitWarehouseId" => wh3.id
          }
        end,
        update: fn -> %{"remarks" => "矩阵写侧改动-#{System.unique_integer([:positive])}"} end
      },
      SynieCore.Mfg.Operation => %{
        create: fn _company ->
          %{
            "code" => "MXWOP#{System.unique_integer([:positive])}",
            "name" => "矩阵写工序"
          }
        end,
        update: fn -> %{"name" => "矩阵写工序-改名-#{System.unique_integer([:positive])}"} end
      },
      SynieCore.Mfg.ProcessTemplate => %{
        create: fn _company ->
          %{
            "code" => "MXWRT#{System.unique_integer([:positive])}",
            "name" => "矩阵写工艺路线"
          }
        end,
        update: fn -> %{"name" => "矩阵写工艺路线-改名-#{System.unique_integer([:positive])}"} end
      },
      # BOM 每物料至多一份:正向落在备用物料上(世界 BOM 在主物料)
      SynieCore.Mfg.Bom => %{
        create: fn _company -> %{"materialId" => ctx.material2.id} end,
        update: fn -> %{"note" => "矩阵写侧改动-#{System.unique_integer([:positive])}"} end
      },
      # ── sales(批次D)──
      SynieCore.Sales.Customer => %{
        create: fn _company ->
          %{"code" => "MXWC#{System.unique_integer([:positive])}", "name" => "矩阵写客户"}
        end,
        update: fn -> %{"name" => "矩阵写客户-改名-#{System.unique_integer([:positive])}"} end
      },
      # 正向 create 用样品单免报价链接;币种传本币(GraphQL currencyId 必填),
      # 本币单汇率被强制为 1,故省略 exchangeRate
      SynieCore.Sales.Order => %{
        create: fn company ->
          %{
            "companyId" => company.id,
            "orderNo" => "MXWSO-#{System.unique_integer([:positive])}",
            "orderDate" => "2026-07-02",
            "orderType" => {:enum, "SAMPLE"},
            "partyType" => {:enum, "CUSTOMER"},
            "partyId" => ctx.customer.id,
            "currencyId" => ctx.cny.id
          }
        end,
        update: fn -> %{"remarks" => "矩阵写侧改动-#{System.unique_integer([:positive])}"} end
      },
      # 空草稿发货可建可删(无明细即无库存联动);借方未开票应收,贷方任意
      SynieCore.Sales.Delivery => %{
        create: fn company ->
          %{
            "companyId" => company.id,
            "deliveryNo" => "MXWDL-#{System.unique_integer([:positive])}",
            "deliveryDate" => "2026-07-02",
            "partyType" => {:enum, "CUSTOMER"},
            "partyId" => ctx.customer.id,
            "debitAccountId" => unbilled_receivable_of(ctx, company).id,
            "creditAccountId" => account_of(ctx, company).id
          }
        end,
        update: fn -> %{"remarks" => "矩阵写侧改动-#{System.unique_integer([:positive])}"} end
      },
      SynieCore.Sales.Quotation => %{
        create: fn company ->
          %{
            "companyId" => company.id,
            "quotationNo" => "MXWSQ-#{System.unique_integer([:positive])}",
            "quotationDate" => "2026-07-02",
            "validUntil" => "2026-12-31",
            "partyType" => {:enum, "CUSTOMER"},
            "partyId" => ctx.customer.id,
            "currencyId" => ctx.cny.id
          }
        end,
        update: fn -> %{"remarks" => "矩阵写侧改动-#{System.unique_integer([:positive])}"} end
      },
      SynieCore.Sales.Reconciliation => %{
        create: fn company ->
          %{
            "companyId" => company.id,
            "reconciliationNo" => "MXWSR-#{System.unique_integer([:positive])}",
            "reconciliationType" => {:enum, "REGULAR"},
            "partyType" => {:enum, "CUSTOMER"},
            "partyId" => ctx.customer.id,
            "debitAccountId" => account_of(ctx, company).id,
            "creditAccountId" => unbilled_receivable_of(ctx, company).id
          }
        end,
        update: fn -> %{"remarks" => "矩阵写侧改动-#{System.unique_integer([:positive])}"} end
      },
      SynieCore.Sales.Setting => %{
        update: fn -> %{"sampleItemMaxQty" => 100} end
      },
      # ── purchase(批次D)──
      SynieCore.Purchase.Supplier => %{
        create: fn _company ->
          %{"code" => "MXWS#{System.unique_integer([:positive])}", "name" => "矩阵写供应商"}
        end,
        update: fn -> %{"name" => "矩阵写供应商-改名-#{System.unique_integer([:positive])}"} end
      },
      SynieCore.Purchase.Order => %{
        create: fn company ->
          %{
            "companyId" => company.id,
            "orderNo" => "MXWPO-#{System.unique_integer([:positive])}",
            "orderDate" => "2026-07-02",
            "partyType" => {:enum, "SUPPLIER"},
            "partyId" => ctx.supplier.id,
            "currencyId" => ctx.cny.id
          }
        end,
        update: fn -> %{"remarks" => "矩阵写侧改动-#{System.unique_integer([:positive])}"} end
      },
      SynieCore.Purchase.Receipt => %{
        create: fn company ->
          %{
            "companyId" => company.id,
            "receiptNo" => "MXWRC-#{System.unique_integer([:positive])}",
            "receiptDate" => "2026-07-02",
            "partyType" => {:enum, "SUPPLIER"},
            "partyId" => ctx.supplier.id,
            "debitAccountId" => account_of(ctx, company).id,
            "creditAccountId" => unbilled_payable_of(ctx, company).id
          }
        end,
        update: fn -> %{"remarks" => "矩阵写侧改动-#{System.unique_integer([:positive])}"} end
      },
      SynieCore.Purchase.Quotation => %{
        create: fn company ->
          %{
            "companyId" => company.id,
            "quotationNo" => "MXWPQ-#{System.unique_integer([:positive])}",
            "quotationDate" => "2026-07-02",
            "validUntil" => "2026-12-31",
            "partyType" => {:enum, "SUPPLIER"},
            "partyId" => ctx.supplier.id,
            "currencyId" => ctx.cny.id
          }
        end,
        update: fn -> %{"remarks" => "矩阵写侧改动-#{System.unique_integer([:positive])}"} end
      },
      SynieCore.Purchase.Reconciliation => %{
        create: fn company ->
          %{
            "companyId" => company.id,
            "reconciliationNo" => "MXWPR-#{System.unique_integer([:positive])}",
            "reconciliationType" => {:enum, "REGULAR"},
            "partyType" => {:enum, "SUPPLIER"},
            "partyId" => ctx.supplier.id,
            "debitAccountId" => unbilled_payable_of(ctx, company).id,
            "creditAccountId" => account_of(ctx, company).id
          }
        end,
        update: fn -> %{"remarks" => "矩阵写侧改动-#{System.unique_integer([:positive])}"} end
      }
    }
  end

  # 写输入的按公司取数辅助(只在输入闭包内调用)
  defp bank_account_of(ctx, company),
    do: if(company.id == ctx.company_a.id, do: ctx.bank_account_a, else: ctx.bank_account_b)

  defp account_of(ctx, company),
    do: if(company.id == ctx.company_a.id, do: ctx.account_a, else: ctx.account_b)

  defp unbilled_receivable_of(ctx, company),
    do: if(company.id == ctx.company_a.id, do: ctx.account_ur_a, else: ctx.account_ur_b)

  defp unbilled_payable_of(ctx, company),
    do: if(company.id == ctx.company_a.id, do: ctx.account_up_a, else: ctx.account_up_b)

  defp bill_of(ctx, company),
    do: if(company.id == ctx.company_a.id, do: ctx.bill_a, else: ctx.bill_b)

  defp warehouses_of(ctx, company),
    do: if(company.id == ctx.company_a.id, do: ctx.warehouses_a, else: ctx.warehouses_b)

  defp warehouse_of(ctx, company), do: ctx |> warehouses_of(company) |> hd()

  # ── 应得集声明 ────────────────────────────────────────────────────────────

  @doc """
  资源的应得集声明。默认规则:有 company_id 按公司匹配(:company),否则全局有码即读(:global)。
  特例由默认子句上方的资源专属函数头声明 {:custom, fun}(见 moduledoc)。
  """
  # 审计日志:无公司行放行(系统级操作),有公司行按公司匹配
  def visibility(SynieCore.Audit.Log), do: {:custom, &audit_log_visible?/2}

  # 票据:全局票据实体随交易可见(任一笔本司交易触达即应得)
  def visibility(SynieCore.Acc.Bill), do: {:custom, &bill_visible?/2}

  def visibility(module) do
    if Ash.Resource.Info.attribute(module, :company_id), do: :company, else: :global
  end

  defp audit_log_visible?(record, effective_companies) do
    is_nil(record.company_id) or effective_companies == :all or
      record.company_id in effective_companies
  end

  defp bill_visible?(record, effective_companies) do
    effective_companies == :all or
      Enum.any?(record.transactions, &(&1.company_id in effective_companies))
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

  @doc """
  世界覆盖豁免:权限前缀 => 理由。批次A-D 已全部落地,清单为空——
  自此新资源进权限目录而不写构造函数,完整性守卫即红(工单10 收口)。
  """
  def coverage_exempt, do: %{}

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

    # 跨域标准数据:员工/客户是全局主数据,批次B的单据(报销/发票/票据)引用它们;
    # 对应资源的构造函数在批次C(hr.employee)/批次D(sales.customer)落地时**必须认领**
    # 这两条记录,否则该批次的独占「恰好等于」断言会红(守卫即提醒)。
    employee = employee!()
    customer = customer!()

    account_a = bas_account!(company_a)
    account_b = bas_account!(company_b)
    bank_account_a = bank_account!(company_a, cny)
    bank_account_b = bank_account!(company_b, cny)

    # 票据流:全局票据实体 + 每司一笔已审核收票交易(Ash.Seed 受信种入,绕状态机)
    # + 重放引擎推导持仓。票据可见性随交易公司(见 visibility 特例)。
    {bill_a, bill_txn_a} = bill_with_audited_receive!(company_a, bank_account_a, customer)
    {bill_b, bill_txn_b} = bill_with_audited_receive!(company_b, bank_account_b, customer)

    # 批次C标准数据:仓库每司三座(调拨需 from/to/transit 两两不同);物料 code
    # 强制自动编号(manual_entry: false),须先备好 inv.material 编号规则;
    # 考勤打卡的 import 外键用 Ash.Seed 种入(真实导入要可解析 .dat,越出矩阵射程);
    # 工资单进 ctx 供发放行引用。
    warehouses_a = for n <- 1..3, do: warehouse!(company_a, n)
    warehouses_b = for n <- 1..3, do: warehouse!(company_b, n)
    material_rule = material_numbering_rule!()
    category = material_category!()
    material = material!(category, unit)
    material2 = material!(category, unit)
    attendance_import = Ash.Seed.seed!(SynieCore.Hr.AttendanceImport, %{file_id: bare_file.id})
    payroll = payroll!(employee)

    # 批次D标准数据:供应商(全局)+ 带角色科目(发货借方须未开票应收、
    # 收货贷方须未开票应付,对账镜像),销采单据引用它们与批次B/C的客户/物料/仓库。
    supplier = supplier!()
    account_ur_a = role_account!(company_a, "MXUR", :unbilled_receivable)
    account_ur_b = role_account!(company_b, "MXUR", :unbilled_receivable)
    account_up_a = role_account!(company_a, "MXUP", :unbilled_payable)
    account_up_b = role_account!(company_b, "MXUP", :unbilled_payable)

    # 销售订单:已审核 + 含明细行(发货明细须绑已审核订单条目);两司各一张。
    # 订单是矩阵记录本体(审核后仍是该资源唯一世界记录,读矩阵照常;写矩阵负向
    # 对已审核订单的 destroy 被公司轴与草稿闸双重挡下,拒即达标)。
    {sales_order_a, sales_order_item_a} =
      audited_sales_order!(company_a, customer, material, unit)

    {sales_order_b, sales_order_item_b} =
      audited_sales_order!(company_b, customer, material, unit)

    delivery_a =
      delivery_with_item!(
        company_a,
        customer,
        account_ur_a,
        account_a,
        sales_order_item_a,
        hd(warehouses_a)
      )

    delivery_b =
      delivery_with_item!(
        company_b,
        customer,
        account_ur_b,
        account_b,
        sales_order_item_b,
        hd(warehouses_b)
      )

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
      instrument: instrument,
      employee: employee,
      customer: customer,
      account_a: account_a,
      account_b: account_b,
      bank_account_a: bank_account_a,
      bank_account_b: bank_account_b,
      bill_a: bill_a,
      bill_b: bill_b,
      bill_txn_a: bill_txn_a,
      bill_txn_b: bill_txn_b,
      warehouses_a: warehouses_a,
      warehouses_b: warehouses_b,
      material_rule: material_rule,
      category: category,
      material: material,
      material2: material2,
      attendance_import: attendance_import,
      payroll: payroll,
      supplier: supplier,
      account_ur_a: account_ur_a,
      account_ur_b: account_ur_b,
      account_up_a: account_up_a,
      account_up_b: account_up_b,
      sales_order_a: sales_order_a,
      sales_order_b: sales_order_b,
      delivery_a: delivery_a,
      delivery_b: delivery_b
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

  # 员工 code 挂 AutoNumber 但允许手填;显式给 code 免依赖编号规则
  defp employee! do
    SynieCore.Hr.Employee
    |> Ash.Changeset.for_create(:create, %{
      code: "MXE#{System.unique_integer([:positive])}",
      name: "矩阵员工"
    })
    |> Ash.create!(authorize?: false)
  end

  defp customer! do
    SynieCore.Sales.Customer
    |> Ash.Changeset.for_create(:create, %{
      code: "MXC#{System.unique_integer([:positive])}",
      name: "矩阵客户"
    })
    |> Ash.create!(authorize?: false)
  end

  defp supplier! do
    SynieCore.Purchase.Supplier
    |> Ash.Changeset.for_create(:create, %{
      code: "MXS#{System.unique_integer([:positive])}",
      name: "矩阵供应商"
    })
    |> Ash.create!(authorize?: false)
  end

  # 带往来角色的科目(发货/收货/对账的借贷科目须挂特定角色,见各资源 *AccountRole 校验)
  defp role_account!(company, code_prefix, role) do
    SynieCore.Base.Account
    |> Ash.Changeset.for_create(:create, %{
      code: "#{code_prefix}#{System.unique_integer([:positive])}",
      name: "矩阵#{role}-#{company.code}",
      direction: :debit,
      role: role,
      company_id: company.id
    })
    |> Ash.create!(authorize?: false)
  end

  defp bas_account!(company) do
    SynieCore.Base.Account
    |> Ash.Changeset.for_create(:create, %{
      code: "MX01",
      name: "矩阵科目-#{company.code}",
      direction: :debit,
      company_id: company.id
    })
    |> Ash.create!(authorize?: false)
  end

  defp bank_account!(company, currency) do
    suffix = System.unique_integer([:positive])

    SynieCore.Acc.BankAccount
    |> Ash.Changeset.for_create(:create, %{
      alias: "矩阵户-#{company.code}",
      bank_name: "矩阵银行",
      holder_name: "矩阵持有人",
      account_no: "62#{suffix}",
      company_id: company.id,
      currency_id: currency.id
    })
    |> Ash.create!(authorize?: false)
  end

  defp warehouse!(company, n) do
    SynieCore.Inv.Warehouse
    |> Ash.Changeset.for_create(:create, %{
      name: "矩阵仓#{n}-#{company.code}",
      company_id: company.id
    })
    |> Ash.create!(authorize?: false)
  end

  # 物料 code 强制自动编号(不接受手填),世界须自带启用的编号规则
  defp material_numbering_rule! do
    SynieCore.Numbering.Rule
    |> Ash.Changeset.for_create(:create, %{
      resource: "inv.material",
      name: "矩阵物料编号",
      segments: [
        %{"type" => "text", "value" => "MXM"},
        %{"type" => "seq", "padding" => 4}
      ],
      per_company: false
    })
    |> Ash.create!(authorize?: false)
  end

  defp material_category! do
    SynieCore.Inv.MaterialCategory
    |> Ash.Changeset.for_create(:create, %{
      code: "MX#{System.unique_integer([:positive])}",
      name: "矩阵分类"
    })
    |> Ash.create!(authorize?: false)
  end

  defp material!(category, unit) do
    SynieCore.Inv.Material
    |> Ash.Changeset.for_create(:create, %{
      name: "矩阵物料-#{System.unique_integer([:positive])}",
      category_id: category.id,
      default_unit_id: unit.id
    })
    |> Ash.create!(authorize?: false)
  end

  defp payroll!(employee) do
    SynieCore.Hr.Payroll
    |> Ash.Changeset.for_create(:create, %{employee_id: employee.id, month: "2026-06"})
    |> Ash.create!(authorize?: false)
  end

  # 票据 + 已审核收票交易:票据经内部 :register 建档;交易以 Ash.Seed 直接种为
  # :audited(绕过审核动作的 GL 联动,保住 acc.gl_entry 的独占世界);
  # 再跑重放引擎推导持仓(BillHolding 的唯一合法写入路径)。
  defp bill_with_audited_receive!(company, bank_account, customer) do
    suffix = System.unique_integer([:positive])

    bill =
      SynieCore.Acc.Bill
      |> Ash.Changeset.for_create(:register, %{
        bill_no: "MXB#{suffix}",
        bill_kind: :bank_acceptance,
        due_date: ~D[2026-12-31],
        face_amount: Decimal.new("1")
      })
      |> Ash.create!(authorize?: false)

    txn =
      Ash.Seed.seed!(SynieCore.Acc.BillTransaction, %{
        doc_no: "MXBT#{suffix}",
        transaction_type: :receive,
        occurred_on: ~D[2026-07-01],
        sub_start: 1,
        sub_end: 100,
        amount: Decimal.new("1"),
        party_type: :customer,
        party_id: customer.id,
        status: :audited,
        company_id: company.id,
        bank_account_id: bank_account.id,
        bill_id: bill.id
      })

    SynieCore.Acc.BillLedger.replay!(bill.id)

    # 票据可见性 oracle 消费预载的 transactions(见 visibility 特例)
    {Ash.load!(bill, :transactions, authorize?: false), txn}
  end

  # 已审核销售订单 + 一行样品条目(样品行免报价链接,qty≤样品上限);返回 {订单, 订单条目}。
  # 发货明细须绑已审核订单条目,故订单在此审核(本币单省略币种/汇率,SyncCurrency 代入本币)。
  defp audited_sales_order!(company, customer, material, unit) do
    suffix = System.unique_integer([:positive])

    order =
      SynieCore.Sales.Order
      |> Ash.Changeset.for_create(:create, %{
        company_id: company.id,
        order_no: "MXSO-#{company.code}-#{suffix}",
        order_date: ~D[2026-07-01],
        order_type: :sample,
        party_type: :customer,
        party_id: customer.id
      })
      |> Ash.create!(authorize?: false)

    item =
      SynieCore.Sales.OrderItem
      |> Ash.Changeset.for_create(:create, %{
        order_id: order.id,
        idx: 1,
        material_id: material.id,
        unit_id: unit.id,
        qty: Decimal.new("1"),
        price: Decimal.new("10")
      })
      |> Ash.create!(authorize?: false)

    order =
      order
      |> Ash.Changeset.for_update(:audit, %{})
      |> Ash.update!(authorize?: false)

    {order, item}
  end

  # 草稿发货单 + 一行明细(绑已审核订单条目);借方须挂未开票应收角色,贷方任意本司科目。
  # 发货保持草稿(审核才动库存/过账,越出全量矩阵射程),明细可挂在草稿发货上。
  defp delivery_with_item!(
         company,
         customer,
         debit_account,
         credit_account,
         order_item,
         warehouse
       ) do
    suffix = System.unique_integer([:positive])

    delivery =
      SynieCore.Sales.Delivery
      |> Ash.Changeset.for_create(:create, %{
        company_id: company.id,
        delivery_no: "MXDL-#{company.code}-#{suffix}",
        delivery_date: ~D[2026-07-02],
        party_type: :customer,
        party_id: customer.id,
        debit_account_id: debit_account.id,
        credit_account_id: credit_account.id
      })
      |> Ash.create!(authorize?: false)

    SynieCore.Sales.DeliveryItem
    |> Ash.Changeset.for_create(:create, %{
      delivery_id: delivery.id,
      idx: 1,
      order_item_id: order_item.id,
      qty: Decimal.new("1"),
      warehouse_id: warehouse.id
    })
    |> Ash.create!(authorize?: false)

    delivery
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

  defp build_numbering_rules(%{material_rule: material_rule}) do
    [
      material_rule,
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

  # 认领全部世界科目:每司普通科目 + 未开票应收/应付角色科目(销采单据借贷用)
  defp build_bas_accounts(ctx) do
    [
      ctx.account_a,
      ctx.account_b,
      ctx.account_ur_a,
      ctx.account_ur_b,
      ctx.account_up_a,
      ctx.account_up_b
    ]
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

  # ── 构造函数:acc(批次B)──────────────────────────────────────────────────

  defp build_bank_accounts(%{bank_account_a: a, bank_account_b: b}), do: [a, b]

  defp build_bank_import_templates(ctx) do
    for {company, bank_account} <- [
          {ctx.company_a, ctx.bank_account_a},
          {ctx.company_b, ctx.bank_account_b}
        ] do
      SynieCore.Acc.BankImportTemplate
      |> Ash.Changeset.for_create(:create, %{
        name: "矩阵模板-#{company.code}",
        company_id: company.id,
        bank_account_id: bank_account.id,
        datetime_col: "A",
        datetime_format: :ymd_dash_hms,
        income_col: "C",
        expense_col: "D"
      })
      |> Ash.create!(authorize?: false)
    end
  end

  defp build_bank_transactions(ctx) do
    for {company, bank_account} <- [
          {ctx.company_a, ctx.bank_account_a},
          {ctx.company_b, ctx.bank_account_b}
        ] do
      SynieCore.Acc.BankTransaction
      |> Ash.Changeset.for_create(:create, %{
        occurred_at: ~U[2026-07-01 10:30:00Z],
        income: Decimal.new("100.50"),
        company_id: company.id,
        bank_account_id: bank_account.id
      })
      |> Ash.create!(authorize?: false)
    end
  end

  defp build_bills(%{bill_a: a, bill_b: b}), do: [a, b]

  defp build_bill_transactions(%{bill_txn_a: a, bill_txn_b: b}), do: [a, b]

  # 持仓由重放引擎在 ctx 票据流里推导,此处按世界票据认领
  defp build_bill_holdings(%{bill_a: bill_a, bill_b: bill_b}) do
    require Ash.Query

    SynieCore.Acc.BillHolding
    |> Ash.Query.filter(bill_id in ^[bill_a.id, bill_b.id])
    |> Ash.read!(authorize?: false)
  end

  defp build_expense_reports(ctx) do
    for {company, account} <- [{ctx.company_a, ctx.account_a}, {ctx.company_b, ctx.account_b}] do
      SynieCore.Acc.ExpenseReport
      |> Ash.Changeset.for_create(:create, %{
        company_id: company.id,
        doc_no: "MXBX-#{company.code}-#{System.unique_integer([:positive])}",
        employee_id: ctx.employee.id,
        expense_date: ~D[2026-07-01],
        payment_account_id: account.id
      })
      |> Ash.create!(authorize?: false)
    end
  end

  # 总账分录:资源层无动作校验,直建最小合法行(单边非零由 DB 约束把关);
  # 全量矩阵不走 GL.post!(借贷平衡等业务校验有各自功能测试)
  defp build_gl_entries(ctx) do
    for {company, account} <- [{ctx.company_a, ctx.account_a}, {ctx.company_b, ctx.account_b}] do
      SynieCore.Acc.GlEntry
      |> Ash.Changeset.for_create(:create, %{
        company_id: company.id,
        account_id: account.id,
        posting_date: ~D[2026-07-01],
        debit: Decimal.new("100"),
        voucher_type: "authz_matrix",
        voucher_id: Ash.UUID.generate(),
        voucher_no: "MXGL-#{company.code}"
      })
      |> Ash.create!(authorize?: false)
    end
  end

  # acc_setting 单行由迁移种入且资源不开放 create,认领种子行
  defp build_acc_settings(_ctx), do: [SynieCore.Acc.Setting.get()]

  # 发票取最省依赖形态:进项 + 员工对手(免对账单/客商依赖)
  defp build_vat_invoices(ctx) do
    for company <- [ctx.company_a, ctx.company_b] do
      SynieCore.Acc.VatInvoice
      |> Ash.Changeset.for_create(:create, %{
        company_id: company.id,
        doc_no: "MXFP-#{company.code}-#{System.unique_integer([:positive])}",
        direction: :inbound,
        invoice_date: ~D[2026-07-01],
        party_type: :employee,
        party_id: ctx.employee.id,
        invoice_kind: :normal
      })
      |> Ash.create!(authorize?: false)
    end
  end

  # ── 构造函数:hr(批次C,全域全局主数据)───────────────────────────────────

  defp build_employees(%{employee: employee}), do: [employee]

  defp build_attendance_punches(%{employee: employee, attendance_import: import}) do
    [
      SynieCore.Hr.AttendancePunch
      |> Ash.Changeset.for_create(:create, %{
        employee_id: employee.id,
        attendance_no: "MXP#{System.unique_integer([:positive])}",
        punched_at: ~U[2026-07-01 00:10:00Z],
        import_id: import.id
      })
      |> Ash.create!(authorize?: false)
    ]
  end

  # 考勤日直建最小合法行(重算引擎的 upsert 动作,受信路径可直用);
  # 日期避开世界/写输入的补卡日,防重算覆盖(见 shared 声明)
  defp build_attendance_days(%{employee: employee}) do
    [
      SynieCore.Hr.AttendanceDay
      |> Ash.Changeset.for_create(:create, %{
        employee_id: employee.id,
        date: ~D[2026-07-01],
        normal_hours: Decimal.new("8"),
        overtime_hours: Decimal.new("0"),
        bonus_workday: Decimal.new("0"),
        status: :ok
      })
      |> Ash.create!(authorize?: false)
    ]
  end

  defp build_attendance_corrections(%{employee: employee}) do
    [
      SynieCore.Hr.AttendanceCorrection
      |> Ash.Changeset.for_create(:create, %{
        employee_id: employee.id,
        date: ~D[2026-07-03],
        times: [~T[08:00:00]]
      })
      |> Ash.create!(authorize?: false)
    ]
  end

  defp build_employee_loans(%{employee: employee}) do
    [
      SynieCore.Hr.EmployeeLoan
      |> Ash.Changeset.for_create(:create, %{
        employee_id: employee.id,
        kind: :borrow,
        occurred_on: ~D[2026-07-01],
        amount: Decimal.new("100")
      })
      |> Ash.create!(authorize?: false)
    ]
  end

  defp build_payrolls(%{payroll: payroll}), do: [payroll]

  # 发放行会把工资单翻为已发放(世界不变式按 id,状态翻转无碍)
  defp build_payroll_payments(%{payroll: payroll}) do
    [
      SynieCore.Hr.PayrollPayment
      |> Ash.Changeset.for_create(:create, %{
        payroll_id: payroll.id,
        paid_on: ~D[2026-07-05],
        amount: Decimal.new("100")
      })
      |> Ash.create!(authorize?: false)
    ]
  end

  # ── 构造函数:inv(批次C)─────────────────────────────────────────────────

  defp build_material_categories(%{category: category}), do: [category]

  defp build_materials(%{material: material, material2: material2}), do: [material, material2]

  defp build_stock_docs(ctx) do
    for {company, [warehouse | _]} <- [
          {ctx.company_a, ctx.warehouses_a},
          {ctx.company_b, ctx.warehouses_b}
        ] do
      SynieCore.Inv.StockDoc
      |> Ash.Changeset.for_create(:create, %{
        company_id: company.id,
        doc_no: "MXCRK-#{company.code}-#{System.unique_integer([:positive])}",
        direction: :in,
        warehouse_id: warehouse.id
      })
      |> Ash.create!(authorize?: false)
    end
  end

  defp build_stock_counts(ctx) do
    for {company, [warehouse | _]} <- [
          {ctx.company_a, ctx.warehouses_a},
          {ctx.company_b, ctx.warehouses_b}
        ] do
      SynieCore.Inv.StockCount
      |> Ash.Changeset.for_create(:create, %{
        company_id: company.id,
        doc_no: "MXPD-#{company.code}-#{System.unique_integer([:positive])}",
        warehouse_id: warehouse.id,
        posting_date: ~D[2026-07-01]
      })
      |> Ash.create!(authorize?: false)
    end
  end

  defp build_stock_transfers(ctx) do
    for {company, [wh1, wh2, wh3]} <- [
          {ctx.company_a, ctx.warehouses_a},
          {ctx.company_b, ctx.warehouses_b}
        ] do
      SynieCore.Inv.StockTransfer
      |> Ash.Changeset.for_create(:create, %{
        company_id: company.id,
        doc_no: "MXDB-#{company.code}-#{System.unique_integer([:positive])}",
        from_warehouse_id: wh1.id,
        to_warehouse_id: wh2.id,
        transit_warehouse_id: wh3.id
      })
      |> Ash.create!(authorize?: false)
    end
  end

  # 库存分录:资源层无动作校验,直建最小合法行(与 gl_entry 同款裁量)
  defp build_stock_entries(ctx) do
    for {company, [warehouse | _]} <- [
          {ctx.company_a, ctx.warehouses_a},
          {ctx.company_b, ctx.warehouses_b}
        ] do
      SynieCore.Inv.StockEntry
      |> Ash.Changeset.for_create(:create, %{
        company_id: company.id,
        warehouse_id: warehouse.id,
        material_id: ctx.material.id,
        quantity: Decimal.new("1"),
        posting_date: ~D[2026-07-01],
        voucher_type: "authz_matrix",
        voucher_id: Ash.UUID.generate(),
        voucher_no: "MXST-#{company.code}"
      })
      |> Ash.create!(authorize?: false)
    end
  end

  # ── 构造函数:mfg(批次C,全域全局)─────────────────────────────────────────

  defp build_operations(_ctx) do
    [
      SynieCore.Mfg.Operation
      |> Ash.Changeset.for_create(:create, %{
        code: "MXOP#{System.unique_integer([:positive])}",
        name: "矩阵工序"
      })
      |> Ash.create!(authorize?: false)
    ]
  end

  defp build_process_templates(_ctx) do
    [
      SynieCore.Mfg.ProcessTemplate
      |> Ash.Changeset.for_create(:create, %{
        code: "MXRT#{System.unique_integer([:positive])}",
        name: "矩阵工艺路线"
      })
      |> Ash.create!(authorize?: false)
    ]
  end

  defp build_boms(%{material: material}) do
    [
      SynieCore.Mfg.Bom
      |> Ash.Changeset.for_create(:create, %{material_id: material.id})
      |> Ash.create!(authorize?: false)
    ]
  end

  # ── 构造函数:sales(批次D)───────────────────────────────────────────────

  defp build_customers(%{customer: customer}), do: [customer]

  defp build_sales_orders(%{sales_order_a: a, sales_order_b: b}), do: [a, b]

  defp build_deliveries(%{delivery_a: a, delivery_b: b}), do: [a, b]

  defp build_sales_quotations(ctx) do
    for company <- [ctx.company_a, ctx.company_b] do
      SynieCore.Sales.Quotation
      |> Ash.Changeset.for_create(:create, %{
        company_id: company.id,
        quotation_no: "MXSQ-#{company.code}-#{System.unique_integer([:positive])}",
        quotation_date: ~D[2026-07-01],
        valid_until: ~D[2026-12-31],
        party_type: :customer,
        party_id: ctx.customer.id
      })
      |> Ash.create!(authorize?: false)
    end
  end

  # 空草稿对账单可建;贷方须挂未开票应收角色,借方任意本司科目
  defp build_sales_reconciliations(ctx) do
    for {company, credit, debit} <- [
          {ctx.company_a, ctx.account_ur_a, ctx.account_a},
          {ctx.company_b, ctx.account_ur_b, ctx.account_b}
        ] do
      SynieCore.Sales.Reconciliation
      |> Ash.Changeset.for_create(:create, %{
        company_id: company.id,
        reconciliation_no: "MXSR-#{company.code}-#{System.unique_integer([:positive])}",
        reconciliation_type: :regular,
        party_type: :customer,
        party_id: ctx.customer.id,
        debit_account_id: debit.id,
        credit_account_id: credit.id
      })
      |> Ash.create!(authorize?: false)
    end
  end

  # sal_setting 单行由迁移种入且资源不开放 create,认领种子行
  defp build_sales_settings(_ctx), do: [SynieCore.Sales.Setting.get()]

  # ── 构造函数:purchase(批次D)────────────────────────────────────────────

  defp build_suppliers(%{supplier: supplier}), do: [supplier]

  defp build_purchase_orders(ctx) do
    for company <- [ctx.company_a, ctx.company_b] do
      SynieCore.Purchase.Order
      |> Ash.Changeset.for_create(:create, %{
        company_id: company.id,
        order_no: "MXPO-#{company.code}-#{System.unique_integer([:positive])}",
        order_date: ~D[2026-07-01],
        party_type: :supplier,
        party_id: ctx.supplier.id
      })
      |> Ash.create!(authorize?: false)
    end
  end

  # 空草稿收货单:借方任意本司科目,贷方须挂未开票应付角色(与发货借贷镜像)
  defp build_receipts(ctx) do
    for {company, debit, credit} <- [
          {ctx.company_a, ctx.account_a, ctx.account_up_a},
          {ctx.company_b, ctx.account_b, ctx.account_up_b}
        ] do
      SynieCore.Purchase.Receipt
      |> Ash.Changeset.for_create(:create, %{
        company_id: company.id,
        receipt_no: "MXRC-#{company.code}-#{System.unique_integer([:positive])}",
        receipt_date: ~D[2026-07-01],
        party_type: :supplier,
        party_id: ctx.supplier.id,
        debit_account_id: debit.id,
        credit_account_id: credit.id
      })
      |> Ash.create!(authorize?: false)
    end
  end

  defp build_purchase_quotations(ctx) do
    for company <- [ctx.company_a, ctx.company_b] do
      SynieCore.Purchase.Quotation
      |> Ash.Changeset.for_create(:create, %{
        company_id: company.id,
        quotation_no: "MXPQ-#{company.code}-#{System.unique_integer([:positive])}",
        quotation_date: ~D[2026-07-01],
        valid_until: ~D[2026-12-31],
        party_type: :supplier,
        party_id: ctx.supplier.id
      })
      |> Ash.create!(authorize?: false)
    end
  end

  # 采购对账:借方须挂未开票应付角色,贷方任意本司科目
  defp build_purchase_reconciliations(ctx) do
    for {company, debit, credit} <- [
          {ctx.company_a, ctx.account_up_a, ctx.account_a},
          {ctx.company_b, ctx.account_up_b, ctx.account_b}
        ] do
      SynieCore.Purchase.Reconciliation
      |> Ash.Changeset.for_create(:create, %{
        company_id: company.id,
        reconciliation_no: "MXPR-#{company.code}-#{System.unique_integer([:positive])}",
        reconciliation_type: :regular,
        party_type: :supplier,
        party_id: ctx.supplier.id,
        debit_account_id: debit.id,
        credit_account_id: credit.id
      })
      |> Ash.create!(authorize?: false)
    end
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

  defp build_warehouses(%{warehouses_a: warehouses_a, warehouses_b: warehouses_b}),
    do: warehouses_a ++ warehouses_b
end
