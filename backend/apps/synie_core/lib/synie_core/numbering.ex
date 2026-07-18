defmodule SynieCore.Numbering do
  @moduledoc """
  单据自动取号入口。规则/计数器资源见 `SynieCore.Numbering.Rule` / `Counter`。

  规则按资源绑定(`rule.resource` = 资源 `permission_prefix`),内容是有序段列表;
  计数范围 key = 渲染后的非 seq 段文本(+按公司维度)——无独立重置周期,段里
  日期格式变了 key 自然变、序号自然从头计。

      Numbering.next(changeset)   #=> {:ok, "记JT-202607-0001"}

  计数器递增走 PG upsert 原子操作(并发安全、无锁),不过 Ash 不审计——取号本身
  不留痕,单据落库失败会跳号,序号允许有洞;页面调整当前值走 Ash update 有审计。
  """

  require Ash.Query

  alias SynieCore.Numbering.Rule

  @date_types [
    Ash.Type.Date,
    Ash.Type.UtcDatetime,
    Ash.Type.UtcDatetimeUsec,
    Ash.Type.NaiveDatetime
  ]
  @format_re ~r/^(YYYY|YY|MM|DD)+$/

  @doc "按 changeset 所属资源的启用规则取下一个编号(构建期调用,字段值取自 changeset)。"
  @spec next(Ash.Changeset.t()) :: {:ok, String.t()} | {:error, :no_rule | String.t()}
  def next(changeset) do
    with {:ok, rule} <- fetch_rule(changeset.resource.permission_prefix()),
         {:ok, parts} <- render_parts(rule.segments, changeset),
         {:ok, scope} <- scope_key(rule, changeset, parts) do
      seq = bump(rule.id, scope)
      {:ok, assemble(parts, seq, seq_padding(rule.segments))}
    end
  end

  @doc "校验段列表结构与字段可解析性(规则建/改时用)。"
  @spec validate_segments(String.t() | nil, term()) :: :ok | {:error, String.t()}
  def validate_segments(prefix, segments) do
    cond do
      is_nil(resource_module(prefix)) ->
        {:error, "未知的绑定资源 #{prefix}"}

      not is_list(segments) or segments == [] ->
        {:error, "至少需要一个编号段"}

      Enum.count(segments, &(seg_type(&1) == "seq")) != 1 ->
        {:error, "序号段必须恰好一个"}

      true ->
        module = resource_module(prefix)
        Enum.find_value(segments, :ok, &segment_error(&1, module))
    end
  end

  @doc "按权限码前缀反查 domain 资源模块。"
  def resource_module(prefix) when is_binary(prefix) do
    SynieCore
    |> Ash.Domain.Info.resources()
    |> Enum.find(fn mod ->
      # ensure_loaded:懒加载环境(dev/test)模块未加载时 function_exported? 会误判 false
      Code.ensure_loaded?(mod) and function_exported?(mod, :permission_prefix, 0) and
        mod.permission_prefix() == prefix
    end)
  end

  def resource_module(_), do: nil

  # ---- 段校验 ----

  defp seg_type(%{"type" => type}), do: type
  defp seg_type(_), do: nil

  defp segment_error(%{"type" => "text", "value" => value}, _module)
       when is_binary(value) and value != "",
       do: nil

  defp segment_error(%{"type" => "text"}, _module), do: {:error, "固定文本段不能为空"}

  defp segment_error(%{"type" => "seq"} = seg, _module) do
    padding = Map.get(seg, "padding", 4)
    # 0 = 不补零;1..12 = 补零宽度
    if is_integer(padding) and padding in 0..12, do: nil, else: {:error, "序号位数须在 0~12 之间(0=不补零)"}
  end

  defp segment_error(%{"type" => "field", "field" => path} = seg, module) when is_binary(path) do
    case field_spec(module, path) do
      {:ok, type} ->
        format = Map.get(seg, "format")

        cond do
          type in @date_types and not (is_binary(format) and format =~ @format_re) ->
            {:error, "日期字段 #{path} 须选择格式(YYYY/YY/MM/DD 组合)"}

          type not in @date_types and not is_nil(format) ->
            {:error, "字段 #{path} 不是日期,不能设格式"}

          true ->
            nil
        end

      :error ->
        {:error, "编号字段 #{path} 在绑定资源上不存在"}
    end
  end

  defp segment_error(_seg, _module), do: {:error, "编号段格式不正确"}

  # 字段路径 → 类型:本资源属性("date")或 belongs_to 一级字段("company.code")
  defp field_spec(module, path) do
    case String.split(path, ".", parts: 2) do
      [attr] ->
        with {:ok, attr} <- existing_atom(attr),
             %Ash.Resource.Attribute{type: type} <- Ash.Resource.Info.attribute(module, attr) do
          {:ok, type}
        else
          _ -> :error
        end

      [rel, attr] ->
        with {:ok, rel} <- existing_atom(rel),
             %{type: :belongs_to, destination: destination} <-
               Ash.Resource.Info.relationship(module, rel),
             {:ok, attr} <- existing_atom(attr),
             %Ash.Resource.Attribute{type: type} <- Ash.Resource.Info.attribute(destination, attr) do
          {:ok, type}
        else
          _ -> :error
        end
    end
  end

  defp existing_atom(str) do
    {:ok, String.to_existing_atom(str)}
  rescue
    ArgumentError -> :error
  end

  # ---- 取号 ----

  defp fetch_rule(prefix) do
    Rule
    |> Ash.Query.filter(resource == ^prefix and enabled == true)
    |> Ash.read_one(authorize?: false)
    |> case do
      {:ok, %Rule{} = rule} -> {:ok, rule}
      _ -> {:error, :no_rule}
    end
  end

  # 段列表 → [{:text, 渲染文本} | :seq];字段空值省略该段(不报错)
  defp render_parts(segments, changeset) do
    Enum.reduce_while(segments, {:ok, []}, fn seg, {:ok, acc} ->
      case render_segment(seg, changeset) do
        {:ok, :omit} -> {:cont, {:ok, acc}}
        {:ok, part} -> {:cont, {:ok, [part | acc]}}
        {:error, _} = err -> {:halt, err}
      end
    end)
    |> case do
      {:ok, parts} -> {:ok, Enum.reverse(parts)}
      err -> err
    end
  end

  defp render_segment(%{"type" => "text", "value" => value}, _changeset),
    do: {:ok, {:text, value}}

  defp render_segment(%{"type" => "seq"}, _changeset), do: {:ok, :seq}

  defp render_segment(%{"type" => "field", "field" => path} = seg, changeset) do
    case field_value(changeset, path) do
      # 空则省略:支持物料等「可选客户前缀」与一条规则覆盖多种形态
      {:ok, nil} -> {:ok, :omit}
      {:ok, ""} -> {:ok, :omit}
      {:ok, value} -> render_value(value, Map.get(seg, "format"), path)
      :error -> {:error, "编号字段 #{path} 在资源上不存在"}
    end
  end

  defp field_value(changeset, path) do
    case String.split(path, ".", parts: 2) do
      [attr] ->
        with {:ok, attr} <- existing_atom(attr),
             %Ash.Resource.Attribute{} <- Ash.Resource.Info.attribute(changeset.resource, attr) do
          {:ok, Ash.Changeset.get_attribute(changeset, attr)}
        else
          _ -> :error
        end

      [rel, attr] ->
        with {:ok, rel} <- existing_atom(rel),
             %{type: :belongs_to} = relationship <-
               Ash.Resource.Info.relationship(changeset.resource, rel),
             {:ok, attr} <- existing_atom(attr) do
          case Ash.Changeset.get_attribute(changeset, relationship.source_attribute) do
            nil ->
              {:ok, nil}

            id ->
              case Ash.get(relationship.destination, id, authorize?: false) do
                {:ok, record} -> {:ok, Map.get(record, attr)}
                _ -> {:ok, nil}
              end
          end
        else
          _ -> :error
        end
    end
  end

  defp render_value(%Date{} = date, format, _path) when is_binary(format),
    do: {:ok, {:text, format_date(date, format)}}

  defp render_value(%DateTime{} = dt, format, path),
    do: render_value(DateTime.to_date(dt), format, path)

  defp render_value(%NaiveDateTime{} = dt, format, path),
    do: render_value(NaiveDateTime.to_date(dt), format, path)

  defp render_value(value, nil, _path), do: {:ok, {:text, to_string(value)}}
  defp render_value(_value, _format, path), do: {:error, "编号字段 #{path} 的格式仅适用于日期"}

  defp format_date(date, format) do
    format
    |> String.replace("YYYY", "%Y")
    |> String.replace("YY", "%y")
    |> String.replace("MM", "%m")
    |> String.replace("DD", "%d")
    |> then(&Calendar.strftime(date, &1))
  end

  defp seq_padding(segments) do
    segments
    |> Enum.find(&(seg_type(&1) == "seq"))
    |> Map.get("padding", 4)
  end

  # 计数范围:非 seq 段渲染文本;按公司计数再前缀公司编码(约定 :company 关系)
  defp scope_key(rule, changeset, parts) do
    text = for {:text, s} <- parts, into: "", do: s

    if rule.per_company do
      case company_code(changeset) do
        {:ok, code} -> {:ok, code <> "|" <> text}
        err -> err
      end
    else
      {:ok, text}
    end
  end

  defp company_code(changeset) do
    with %{type: :belongs_to} = rel <-
           Ash.Resource.Info.relationship(changeset.resource, :company),
         id when not is_nil(id) <- Ash.Changeset.get_attribute(changeset, rel.source_attribute),
         {:ok, %{code: code}} when is_binary(code) and code != "" <-
           Ash.get(rel.destination, id, authorize?: false) do
      {:ok, code}
    else
      _ -> {:error, "规则按公司计数,单据缺少公司或公司无编码"}
    end
  end

  defp assemble(parts, seq, padding) do
    Enum.map_join(parts, "", fn
      :seq -> format_seq(seq, padding)
      {:text, s} -> s
    end)
  end

  defp format_seq(seq, 0), do: Integer.to_string(seq)

  defp format_seq(seq, padding) when is_integer(padding) and padding > 0,
    do: seq |> Integer.to_string() |> String.pad_leading(padding, "0")

  # PG upsert:不存在则插 value=1,存在则原子 +1,RETURNING 拿到本次序号
  defp bump(rule_id, scope_key) do
    now = DateTime.utc_now()

    {1, [%{value: value}]} =
      SynieCore.Repo.insert_all(
        "sys_numbering_counter",
        [
          %{
            id: Ecto.UUID.bingenerate(),
            rule_id: Ecto.UUID.dump!(rule_id),
            scope_key: scope_key,
            value: 1,
            inserted_at: now,
            updated_at: now
          }
        ],
        on_conflict: [inc: [value: 1], set: [updated_at: now]],
        conflict_target: [:rule_id, :scope_key],
        returning: [:value]
      )

    value
  end
end
