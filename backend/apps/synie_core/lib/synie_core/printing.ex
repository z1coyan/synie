defmodule SynieCore.Printing do
  @moduledoc """
  单据模板打印/导出编排门面。

  - `print` → 填充后转 PDF
  - `export` → 填充后 xlsx
  权限：print/batch_print/export 按资源权限码；并遵守公司数据权限（单据 read）。
  """

  require Ash.Query

  alias SynieCore.Printing.DocBuilder
  alias SynieCore.Printing.FieldCatalog
  alias SynieCore.Printing.PdfConverter
  alias SynieCore.Printing.Renderer
  alias SynieCore.Printing.Template
  alias SynieCore.Storage

  @max_batch 100

  @doc "列出某资源可用模板（含默认标记），供前端弹窗。"
  def list_templates(resource, actor) when is_binary(resource) do
    if can_use_templates?(resource, actor) do
      # 受信读：模板管理权限与单据打印权限解耦——已按 can_use_templates?/2 校验过
      # 「该资源打印类权限或模板管理读权限」，模板为全局主数据、无公司维度，读取不产生数据权限绕越。
      Template
      |> Ash.Query.filter(resource == ^resource)
      |> Ash.Query.sort(is_default: :desc, name: :asc)
      |> Ash.read(authorize?: false)
    else
      {:error, :forbidden}
    end
  end

  @doc """
  是否可使用（列出/读取）某资源的打印模板：
  拥有 `资源:print`、`资源:export`、`资源:batch_print`、
  `sys.print_template:read` 任一权限即可——模板管理权限与单据打印权限解耦。
  """
  def can_use_templates?(resource, actor) do
    Enum.any?(
      ["print", "export", "batch_print"],
      &SynieCore.Authz.has_permission?(actor, "#{resource}:#{&1}")
    ) or SynieCore.Authz.has_permission?(actor, "sys.print_template:read")
  end

  @doc "字段清单（管理页/前端展示）。"
  def field_catalog(resource), do: FieldCatalog.get(resource)

  def printable_resources, do: FieldCatalog.resources()

  @doc """
  导出 xlsx。

  opts: `template_id` 必填（uuid 或 binary id）
  """
  def export(resource, ids, template_id, actor) do
    with :ok <- check_perm(resource, actor, "export"),
         :ok <- check_batch(ids),
         {:ok, template} <- load_template(template_id, resource),
         {:ok, tpl_bin} <- read_template_file(template),
         {:ok, records} <- load_records(resource, ids, actor),
         {:ok, named_docs} <- build_named_docs(resource, records),
         {:ok, xlsx} <- Renderer.render_sheets(tpl_bin, named_docs) do
      filename = export_filename(resource, records)
      {:ok, %{binary: xlsx, content_type: xlsx_ctype(), filename: filename}}
    end
  end

  @doc "打印 PDF（单条或批量；批量=多块+分页）。"
  def print(resource, ids, template_id, actor) do
    action = if length(ids) > 1, do: "batch_print", else: "print"

    with :ok <- check_perm(resource, actor, action),
         :ok <- check_batch(ids),
         {:ok, template} <- load_template(template_id, resource),
         {:ok, tpl_bin} <- read_template_file(template),
         {:ok, records} <- load_records(resource, ids, actor),
         {:ok, docs} <- build_docs(resource, records),
         {:ok, xlsx} <- Renderer.render_pages(tpl_bin, docs),
         {:ok, pdf} <- convert_pdf(xlsx) do
      filename = print_filename(resource, records)
      {:ok, %{binary: pdf, content_type: "application/pdf", filename: filename}}
    end
  end

  defp convert_pdf(xlsx) do
    case PdfConverter.convert_xlsx_to_pdf(xlsx) do
      {:ok, pdf} ->
        {:ok, pdf}

      {:error, :soffice_not_found} ->
        {:error, "PDF 转换服务不可用（未找到 LibreOffice），请使用导出 Excel 或联系管理员"}

      {:error, :timeout} ->
        {:error, "PDF 转换超时，请减少批量条数或稍后重试"}

      {:error, :no_output} ->
        {:error, "PDF 转换未生成文件"}

      {:error, {:convert_failed, msg}} ->
        {:error, "PDF 转换失败: #{msg}"}

      {:error, :convert_failed} ->
        {:error, "PDF 转换失败"}
    end
  end

  defp check_perm(resource, actor, action) do
    if SynieCore.Authz.has_permission?(actor, "#{resource}:#{action}") do
      :ok
    else
      {:error, :forbidden}
    end
  end

  defp check_batch(ids) when is_list(ids) do
    n = length(ids)

    cond do
      n < 1 -> {:error, "请至少选择一条单据"}
      n > @max_batch -> {:error, "单次最多处理 #{@max_batch} 条"}
      true -> :ok
    end
  end

  # 受信读：调用方（print/4、export/4）已先 check_perm/3 显式校验过动作权限
  # （#{resource}:print/export/batch_print），模板为全局主数据、无公司维度，
  # 此处再走 Template 的 read 策略只会误伤「无 sys.print_template:read 但有打印权限」的正常调用。
  defp load_template(template_id, resource) do
    case Ash.get(Template, template_id, authorize?: false) do
      {:ok, %Template{resource: ^resource} = t} ->
        {:ok, t}

      {:ok, _} ->
        {:error, "模板与单据资源类型不匹配"}

      {:error, _} ->
        {:error, "模板不存在或无权访问"}
    end
  end

  defp read_template_file(%Template{} = t) do
    t = Ash.load!(t, [:file], authorize?: false)
    file = t.file

    case Storage.read(file.storage, file.key) do
      {:ok, bin} -> {:ok, bin}
      {:error, _} -> {:error, "无法读取模板文件"}
    end
  end

  defp load_records(resource, ids, actor) do
    case FieldCatalog.module_for(resource) do
      nil ->
        {:error, "不支持的资源类型 #{resource}"}

      mod ->
        records =
          Enum.map(ids, fn id ->
            case Ash.get(mod, id, actor: actor) do
              {:ok, rec} -> rec
              {:error, _} -> nil
            end
          end)

        if Enum.any?(records, &is_nil/1) do
          {:error, "部分单据不存在或无权查看"}
        else
          {:ok, records}
        end
    end
  end

  defp build_docs(resource, records) do
    Enum.reduce_while(records, {:ok, []}, fn rec, {:ok, acc} ->
      case DocBuilder.build(resource, rec) do
        {:ok, doc} -> {:cont, {:ok, acc ++ [doc]}}
        {:error, msg} -> {:halt, {:error, msg}}
      end
    end)
  end

  defp build_named_docs(resource, records) do
    Enum.reduce_while(records, {:ok, []}, fn rec, {:ok, acc} ->
      case DocBuilder.build(resource, rec) do
        {:ok, doc} ->
          name = sheet_name_for(resource, rec)
          {:cont, {:ok, acc ++ [{name, doc}]}}

        {:error, msg} ->
          {:halt, {:error, msg}}
      end
    end)
  end

  # sheet 名/文件名：display_field → :name → 首个 *_no 属性 → 兜底
  defp sheet_name_for(resource, rec) do
    module = FieldCatalog.module_for(resource)

    candidate =
      cond do
        is_nil(module) ->
          nil

        function_exported?(module, :display_field, 0) ->
          Map.get(rec, module.display_field())

        true ->
          no_or_name_value(module, rec)
      end

    case candidate do
      v when is_binary(v) and v != "" -> v
      _ -> "Sheet"
    end
  end

  defp no_or_name_value(module, rec) do
    names = module |> Ash.Resource.Info.public_attributes() |> Enum.map(& &1.name)

    cond do
      :name in names ->
        Map.get(rec, :name)

      no = Enum.find(names, &String.ends_with?(to_string(&1), "_no")) ->
        Map.get(rec, no)

      true ->
        nil
    end
  end

  defp export_filename(resource, [one]) do
    "#{sheet_name_for(resource, one)}.xlsx"
  end

  defp export_filename(resource, _) do
    "#{resource_label(resource)}-批量-#{Date.utc_today()}.xlsx"
  end

  defp print_filename(resource, [one]) do
    "#{sheet_name_for(resource, one)}.pdf"
  end

  defp print_filename(resource, _) do
    "#{resource_label(resource)}-批量-#{Date.utc_today()}.pdf"
  end

  defp resource_label(resource) do
    case FieldCatalog.module_for(resource) do
      nil ->
        resource

      module ->
        if function_exported?(module, :permission_label, 0),
          do: module.permission_label(),
          else: resource
    end
  end

  defp xlsx_ctype,
    do: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
end
