defmodule SynieWeb.GridMeta do
  @moduledoc """
  数据表格元数据:列定义反射 + 当前 actor 能力集 + 扩展动作描述符。

  资源必须在 @resources 白名单注册(信任边界,不做动态模块查找)。
  capabilities 只驱动前端按钮显隐,真正的权限校验在服务端 Ash policy。
  """

  alias SynieCore.Authz

  @resources %{
    "sysUsers" => SynieCore.Accounts.User,
    "sysRoles" => SynieCore.Authz.Role,
    "basCompanies" => SynieCore.Base.Company,
    "basCurrencies" => SynieCore.Base.Currency,
    "basUnits" => SynieCore.Base.Unit,
    "basAccounts" => SynieCore.Base.Account,
    "salCustomers" => SynieCore.Sales.Customer,
    "purSuppliers" => SynieCore.Purchase.Supplier,
    "hrEmployees" => SynieCore.Hr.Employee,
    "invMaterialCategories" => SynieCore.Inv.MaterialCategory,
    "hrAttendancePunches" => SynieCore.Hr.AttendancePunch,
    "hrAttendanceImports" => SynieCore.Hr.AttendanceImport,
    "sysAuditLogs" => SynieCore.Audit.Log,
    "sysNumberingRules" => SynieCore.Numbering.Rule,
    "sysNumberingCounters" => SynieCore.Numbering.Counter,
    "accGlJournals" => SynieCore.Acc.GlJournal,
    "accGlJournalLines" => SynieCore.Acc.GlJournalLine,
    "accGlEntries" => SynieCore.Acc.GlEntry,
    "accBankAccounts" => SynieCore.Acc.BankAccount,
    "accBankTransactions" => SynieCore.Acc.BankTransaction,
    "accBankImportTemplates" => SynieCore.Acc.BankImportTemplate,
    "accBankImports" => SynieCore.Acc.BankImport,
    "accBankImportItems" => SynieCore.Acc.BankImportItem,
    "accVatInvoices" => SynieCore.Acc.VatInvoice,
    "accBills" => SynieCore.Acc.Bill,
    "accBillTransactions" => SynieCore.Acc.BillTransaction,
    "accBillHoldings" => SynieCore.Acc.BillHolding,
    "accBankReconciliations" => SynieCore.Acc.BankReconciliation,
    "sysFiles" => SynieCore.Files.File,
    "sysStorages" => SynieCore.Files.StorageEndpoint
  }

  @spec resolve(String.t(), Authz.Actor.t() | nil) :: {:ok, map()} | {:error, String.t()}
  def resolve(resource_name, actor) do
    case Map.fetch(@resources, resource_name) do
      {:ok, module} -> {:ok, build(module, actor)}
      :error -> {:error, "未知的表格资源: #{resource_name}"}
    end
  end

  def resources, do: @resources

  @doc "create action 挂了 AutoNumber 的白名单资源(编号规则页的资源下拉候选)。"
  def numberable_resources do
    for {name, module} <- @resources,
        action = Ash.Resource.Info.action(module, :create),
        action != nil,
        Enum.any?(action.changes, &match?(%{change: {SynieCore.Numbering.AutoNumber, _}}, &1)) do
      %{prefix: module.permission_prefix(), grid: name}
    end
  end

  @doc false
  # 公开仅供白名单 resolve/2 内部调用与测试直接反射(如 GridDoc 测试资源);不构成对外 API。
  def build(module, actor) do
    refs = Map.merge(fk_refs(module, actor), poly_refs(module, actor))
    rel_descriptions = rel_descriptions(module)

    %{
      columns:
        Enum.map(
          Ash.Resource.Info.public_attributes(module),
          &column(&1, refs, rel_descriptions)
        ) ++
          Enum.map(Ash.Resource.Info.public_aggregates(module), &aggregate_column/1),
      capabilities: capabilities(module, actor),
      extended_actions: extended_actions(module),
      destroy_mutation: destroy_mutation(module)
    }
  end

  # 聚合列(如凭证借贷合计)仅展示:跨表排序/筛选算子前端未接,fail-closed 关掉
  defp aggregate_column(agg) do
    %{
      name: camelize(agg.name),
      type: if(agg.kind == :count, do: "integer", else: "decimal"),
      label: agg.description || to_string(agg.name),
      sortable: false,
      filterable: false,
      enum_options: nil,
      ref: nil
    }
  end

  defp column(attr, refs, rel_descriptions) do
    case Map.fetch(refs, attr.name) do
      {:ok, ref} ->
        %{
          name: camelize(attr.name),
          type: "fk",
          # belongs_to 的 FK attribute 一般没有 description,兜底用关系上的 description
          label: attr.description || ref[:label] || to_string(attr.name),
          # uuid 排序无意义;筛选走 eq/in(不走 contains,见 filterable?/1 注释);
          # 多态 fk 同样可筛:前端先按变体选目标资源,拼判别 eq + id in
          sortable: false,
          filterable: true,
          enum_options: nil,
          # 普通 fk 带 resource/relation/label_field;多态带 discriminator/variants,其余字段前端拿到 null
          ref: Map.delete(ref, :label)
        }

      :error ->
        %{
          name: camelize(attr.name),
          type: type_name(attr.type),
          # FK 列走退化路径(无权限/白名单外)时 label 也要中文,兜底关系 description
          label: attr.description || rel_descriptions[attr.name] || to_string(attr.name),
          # map/数组(jsonb)列排序合法但语义无意义,不给排序入口
          sortable: attr.type != Ash.Type.Map and not match?({:array, _}, attr.type),
          filterable: filterable?(attr.type),
          enum_options: enum_options(attr.type),
          ref: nil
        }
    end
  end

  # 关系 description 与权限无关,退化路径的列 label 也要有中文兜底
  defp rel_descriptions(module) do
    module
    |> Ash.Resource.Info.relationships()
    |> Enum.filter(&(&1.type == :belongs_to))
    |> Map.new(&{&1.source_attribute, &1.description})
  end

  # belongs_to → fk 元数据。fail-closed:目标资源不在白名单、或 actor 无目标资源 read 权限,
  # 都不产出 ref,该列退化为普通 uuid 列(string/不可筛),前端表单退 TextField。
  defp fk_refs(module, actor) do
    module_names = Map.new(@resources, fn {name, mod} -> {mod, name} end)

    module
    |> Ash.Resource.Info.relationships()
    # 关系非 public 时对应 attribute 若仍 public,会产出 ref 但 GraphQL schema 无此 relation
    # 字段;前端据 ref 拼查询会请求一个 schema 里不存在的字段,整行查询报错,故一并过滤
    |> Enum.filter(&(&1.type == :belongs_to && &1.public?))
    |> Enum.reduce(%{}, fn rel, acc ->
      with {:ok, resource_name} <- Map.fetch(module_names, rel.destination),
           true <- Authz.has_permission?(actor, "#{rel.destination.permission_prefix()}:read") do
        Map.put(acc, rel.source_attribute, %{
          resource: resource_name,
          relation: camelize(rel.name),
          label_field: camelize(display_field(rel.destination)),
          label: rel.description
        })
      else
        _ -> acc
      end
    end)
  end

  # 多态引用(判别枚举/字符串 + 裸 uuid,无 belongs_to)→ fk 元数据:资源声明 poly_refs/0
  # (%{attr => %{discriminator: 判别属性, variants: %{判别值 => 目标资源 | {目标资源, 中文标签}}}})。
  # 变体逐个 fail-closed 裁剪(白名单外/无 read 权限);全被裁则不产出 ref,列退化为普通 uuid 列
  defp poly_refs(module, actor) do
    if function_exported?(module, :poly_refs, 0) do
      module_names = Map.new(@resources, fn {name, mod} -> {mod, name} end)

      Enum.reduce(module.poly_refs(), %{}, fn {attr, %{discriminator: disc, variants: variants}},
                                              acc ->
        disc_type = Ash.Resource.Info.attribute(module, disc).type

        kept =
          for {value, variant} <- variants,
              {dest, label} = variant_dest_label(variant),
              resource_name = module_names[dest],
              resource_name != nil,
              Authz.has_permission?(actor, "#{dest.permission_prefix()}:read") do
            %{
              value: variant_token(disc_type, value),
              resource: resource_name,
              label_field: camelize(display_field(dest)),
              # 筛选器变体下拉的中文标签:显式标签优先,否则从判别枚举 description 取(与 enum_options 同源)
              label: label || enum_label(disc_type, value)
            }
          end

        case kept do
          [] ->
            acc

          kept ->
            Map.put(acc, attr, %{
              discriminator: camelize(disc),
              # 前端据此决定筛选字面量形态:枚举裸 token,字符串带引号
              discriminator_type: if(enum_type?(disc_type), do: "enum", else: "string"),
              variants: Enum.sort_by(kept, & &1.value)
            })
        end
      end)
    else
      %{}
    end
  end

  defp variant_dest_label({dest, label}), do: {dest, label}
  defp variant_dest_label(dest), do: {dest, nil}

  # 与行判别值直接相等比较:枚举列 GraphQL 线上值是大写 token,字符串列原样
  defp variant_token(disc_type, value) do
    if enum_type?(disc_type), do: value |> to_string() |> String.upcase(), else: to_string(value)
  end

  # 显示字段约定:资源实现 display_field/0 覆盖;默认 :name,没有 public :name 属性则
  # 反射取第一个 public string 属性(如凭证的 voucher_no);连 string 属性都没有的资源
  # 退回 :name(join 失败前端退截断 id,与旧行为一致)
  defp display_field(module) do
    if function_exported?(module, :display_field, 0) do
      module.display_field()
    else
      attrs = Ash.Resource.Info.public_attributes(module)

      fallback =
        Enum.find(attrs, &(&1.name == :name)) ||
          Enum.find(attrs, &(&1.type in [Ash.Type.String, Ash.Type.CiString]))

      if fallback, do: fallback.name, else: :name
    end
  end

  # AshGraphql 的 contains 筛选只对 string/ci_string 生成;uuid、裸 atom(非枚举,无 values/0)
  # 与 map(json_string 标量)若仍标 filterable,跨列搜索/该列筛选会拼出后端不存在的算子,
  # 导致整个查询报错。type 映射仍按 string 处理(展示不受影响)。
  defp filterable?({:array, _}), do: false
  defp filterable?(type), do: type not in [Ash.Type.UUID, Ash.Type.Atom, Ash.Type.Map]

  defp capabilities(module, actor) do
    prefix = module.permission_prefix()

    # 复用他人权限码的资源(permission_actions 为空不进权限目录)可另行声明
    # grid_capabilities/0,仅供前端按钮门控(如考勤导入批次的 import)
    actions =
      if function_exported?(module, :grid_capabilities, 0),
        do: module.grid_capabilities(),
        else: module.permission_actions()

    actions
    |> Enum.reject(&(&1 == "read"))
    |> Enum.filter(&Authz.has_permission?(actor, "#{prefix}:#{&1}"))
  end

  defp extended_actions(module) do
    if function_exported?(module, :grid_actions, 0), do: module.grid_actions(), else: []
  end

  defp destroy_mutation(module) do
    AshGraphql.Domain.Info.mutations(SynieCore)
    |> Enum.find(&(&1.resource == module and &1.type == :destroy))
    |> case do
      nil -> nil
      mutation -> camelize(mutation.name)
    end
  end

  defp camelize(name), do: name |> to_string() |> Absinthe.Utils.camelize(lower: true)

  defp type_name(type) do
    cond do
      enum_type?(type) ->
        "enum"

      type in [Ash.Type.Integer] ->
        "integer"

      type in [Ash.Type.Decimal, Ash.Type.Float] ->
        "decimal"

      type in [Ash.Type.Boolean] ->
        "boolean"

      type in [Ash.Type.Date] ->
        "date"

      type in [Ash.Type.UtcDatetime, Ash.Type.UtcDatetimeUsec, Ash.Type.NaiveDatetime] ->
        "datetime"

      true ->
        # string/ci_string/uuid/atom 及未识别类型都按 string 处理(展示与 contains 筛选均适用)
        "string"
    end
  end

  defp enum_type?(type) do
    is_atom(type) and Code.ensure_loaded?(type) and function_exported?(type, :values, 0)
  end

  defp enum_options(type) do
    if enum_type?(type) do
      # value 用 AshGraphql 线上 token(大写):行值、筛选字面量、mutation 输入三处才能直接相等比较
      Enum.map(type.values(), fn value ->
        %{value: value |> to_string() |> String.upcase(), label: enum_label(type, value)}
      end)
    end
  end

  defp enum_label(type, value) do
    if function_exported?(type, :description, 1) do
      type.description(value) || to_string(value)
    else
      to_string(value)
    end
  end
end
