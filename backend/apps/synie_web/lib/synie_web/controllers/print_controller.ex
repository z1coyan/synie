defmodule SynieWeb.PrintController do
  @moduledoc """
  单据模板打印/导出 REST 端点（binary 不走 GraphQL）:

    * `GET /api/print/templates?resource=` — 列出模板
    * `GET /api/print/field-catalog?resource=` — 字段清单
    * `POST /api/print` — body: resource, ids, template_id, mode(print|export)
  """

  use Phoenix.Controller, formats: [:json]

  import Plug.Conn

  def templates(conn, %{"resource" => resource}) do
    with_actor(conn, fn actor ->
      case SynieCore.Printing.list_templates(resource, actor) do
        {:ok, list} ->
          json(conn, %{
            templates:
              Enum.map(list, fn t ->
                %{
                  id: t.id,
                  name: t.name,
                  resource: t.resource,
                  isDefault: t.is_default,
                  remarks: t.remarks
                }
              end)
          })

        {:error, _} ->
          error(conn, 403, "无权查看打印模板")
      end
    end)
  end

  def templates(conn, _), do: error(conn, 422, "缺少 resource 参数")

  def field_catalog(conn, %{"resource" => resource}) do
    with_actor(conn, fn actor ->
      if SynieCore.Printing.can_use_templates?(resource, actor) do
        case SynieCore.Printing.field_catalog(resource) do
          nil ->
            error(conn, 404, "未知资源类型")

          cat ->
            json(conn, %{
              resource: resource,
              fields: Enum.map(cat.fields, &field_json/1),
              loops:
                Enum.map(cat.loops, fn loop ->
                  %{
                    name: loop.name,
                    label: loop.label,
                    fields: Enum.map(loop.fields, &field_json/1)
                  }
                end)
            })
        end
      else
        error(conn, 403, "无权限查看字段清单")
      end
    end)
  end

  def field_catalog(conn, _), do: error(conn, 422, "缺少 resource 参数")

  def create(conn, params) do
    with_actor(conn, fn actor ->
      resource = params["resource"]
      mode = params["mode"]
      template_id = params["template_id"] || params["templateId"]
      ids = normalize_ids(params["ids"])

      cond do
        resource not in SynieCore.Printing.printable_resources() ->
          error(conn, 422, "不支持的资源类型")

        mode not in ["print", "export"] ->
          error(conn, 422, "mode 须为 print 或 export")

        is_nil(template_id) or template_id == "" ->
          error(conn, 422, "请选择打印模板")

        ids == [] ->
          error(conn, 422, "请至少选择一条单据")

        true ->
          result =
            case mode do
              "print" -> SynieCore.Printing.print(resource, ids, template_id, actor)
              "export" -> SynieCore.Printing.export(resource, ids, template_id, actor)
            end

          case result do
            {:ok, %{binary: bin, content_type: ctype, filename: name}} ->
              conn
              |> put_resp_content_type(ctype)
              |> put_resp_header(
                "content-disposition",
                ~s|attachment; filename="#{encode_filename(name)}"|
              )
              |> send_resp(200, bin)

            {:error, :forbidden} ->
              error(conn, 403, "无权限执行该操作")

            {:error, msg} when is_binary(msg) ->
              error(conn, 422, msg)

            {:error, _} ->
              error(conn, 422, "打印/导出失败")
          end
      end
    end)
  end

  defp field_json(%{name: n, label: l}), do: %{name: n, label: l}

  defp normalize_ids(nil), do: []
  defp normalize_ids(ids) when is_list(ids), do: Enum.map(ids, &to_string/1)
  defp normalize_ids(_), do: []

  defp encode_filename(name) do
    # 简单 ASCII 回退：非 latin1 用 URL encode 文件名
    if String.printable?(name) and String.match?(name, ~r/^[\x20-\x7E]+$/) do
      name
    else
      URI.encode(name)
    end
  end

  defp with_actor(conn, fun) do
    case Ash.PlugHelpers.get_actor(conn) do
      nil -> error(conn, 401, "未登录")
      actor -> fun.(actor)
    end
  end

  defp error(conn, status, message) do
    conn |> put_status(status) |> json(%{error: message})
  end
end
