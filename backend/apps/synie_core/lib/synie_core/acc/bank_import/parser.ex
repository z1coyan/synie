defmodule SynieCore.Acc.BankImport.Parser do
  @moduledoc """
  按导入模板解析银行流水 xlsx:`parse(template, binary)` 返回
  `{:ok, [行]}`(行含 row_no 与流水字段,解析失败的字段留空并写入 error)
  或 `{:error, 记录级原因}`(文件不可读/零数据行/超上限)。

  取值规则(spec 拍板):

    * 仅 xlsx(Elixir 生态无 xls 解析),数字单元格按原始字符串取
      (`number_type: String`,对方账号等长数字防浮点失真);
    * Excel 原生日期/时间样式单元格(库转换为 Date/NaiveDateTime)优先于
      模板格式枚举,文本单元格才按格式正则解析;
    * 本地时间按固定偏移转 UTC(`:bank_import_utc_offset_minutes`,默认
      480 即 UTC+8,国内无夏令时不引 tzdata);
    * 金额双列 0/空视为未填、恰一项 > 0,负数报行错;单列按符号拆收/支;
    * 模板未配置的列一律留空;所配列全空的行(表尾空行/合计后空行)静默跳过。
  """

  alias SynieCore.Acc.BankImportTemplate.{DateFormat, DatetimeFormat, TimeFormat}

  @max_rows 5000

  # 文本单元格按格式枚举解析的正则表;命名捕获 y/m/d/h/mi/s,缺省分量按 0 补
  @datetime_regex %{
    ymd_dash_hms:
      ~r/^(?<y>\d{4})-(?<m>\d{1,2})-(?<d>\d{1,2})\s+(?<h>\d{1,2}):(?<mi>\d{1,2}):(?<s>\d{1,2})$/,
    ymd_dash_hm: ~r/^(?<y>\d{4})-(?<m>\d{1,2})-(?<d>\d{1,2})\s+(?<h>\d{1,2}):(?<mi>\d{1,2})$/,
    ymd_slash_hms:
      ~r/^(?<y>\d{4})\/(?<m>\d{1,2})\/(?<d>\d{1,2})\s+(?<h>\d{1,2}):(?<mi>\d{1,2}):(?<s>\d{1,2})$/,
    ymd_slash_hm: ~r/^(?<y>\d{4})\/(?<m>\d{1,2})\/(?<d>\d{1,2})\s+(?<h>\d{1,2}):(?<mi>\d{1,2})$/,
    compact_space: ~r/^(?<y>\d{4})(?<m>\d{2})(?<d>\d{2})\s+(?<h>\d{2})(?<mi>\d{2})(?<s>\d{2})$/,
    compact: ~r/^(?<y>\d{4})(?<m>\d{2})(?<d>\d{2})(?<h>\d{2})(?<mi>\d{2})(?<s>\d{2})$/,
    iso_t:
      ~r/^(?<y>\d{4})-(?<m>\d{1,2})-(?<d>\d{1,2})T(?<h>\d{1,2}):(?<mi>\d{1,2}):(?<s>\d{1,2})$/,
    cn_hms:
      ~r/^(?<y>\d{4})年(?<m>\d{1,2})月(?<d>\d{1,2})日\s*(?<h>\d{1,2}):(?<mi>\d{1,2}):(?<s>\d{1,2})$/,
    mdy_slash_hms:
      ~r/^(?<m>\d{1,2})\/(?<d>\d{1,2})\/(?<y>\d{4})\s+(?<h>\d{1,2}):(?<mi>\d{1,2}):(?<s>\d{1,2})$/,
    dmy_slash_hms:
      ~r/^(?<d>\d{1,2})\/(?<m>\d{1,2})\/(?<y>\d{4})\s+(?<h>\d{1,2}):(?<mi>\d{1,2}):(?<s>\d{1,2})$/
  }

  @date_regex %{
    ymd_dash: ~r/^(?<y>\d{4})-(?<m>\d{1,2})-(?<d>\d{1,2})$/,
    ymd_slash: ~r/^(?<y>\d{4})\/(?<m>\d{1,2})\/(?<d>\d{1,2})$/,
    ymd_compact: ~r/^(?<y>\d{4})(?<m>\d{2})(?<d>\d{2})$/,
    ymd_dot: ~r/^(?<y>\d{4})\.(?<m>\d{1,2})\.(?<d>\d{1,2})$/,
    ymd_cn: ~r/^(?<y>\d{4})年(?<m>\d{1,2})月(?<d>\d{1,2})日$/,
    mdy_slash: ~r/^(?<m>\d{1,2})\/(?<d>\d{1,2})\/(?<y>\d{4})$/,
    dmy_slash: ~r/^(?<d>\d{1,2})\/(?<m>\d{1,2})\/(?<y>\d{4})$/,
    dmy_dash: ~r/^(?<d>\d{1,2})-(?<m>\d{1,2})-(?<y>\d{4})$/
  }

  @time_regex %{
    hms: ~r/^(?<h>\d{1,2}):(?<mi>\d{1,2}):(?<s>\d{1,2})$/,
    hm: ~r/^(?<h>\d{1,2}):(?<mi>\d{1,2})$/,
    hms_compact: ~r/^(?<h>\d{2})(?<mi>\d{2})(?<s>\d{2})$/,
    hms_cn: ~r/^(?<h>\d{1,2})时(?<mi>\d{1,2})分(?<s>\d{1,2})秒$/
  }

  # 字段长度与 acc_bank_transaction 对齐,超长报行错不静默截断
  @max_lengths [
    counterparty_name: {128, "对方户名"},
    counterparty_account: {64, "对方账号"},
    summary: {255, "摘要"},
    note: {255, "备注"}
  ]

  @spec parse(struct(), binary()) :: {:ok, [map()]} | {:error, String.t()}
  def parse(template, binary) do
    with {:ok, package} <- open(binary),
         {:ok, rows} <- first_sheet(package) do
      build_items(template, rows)
    end
  end

  # 库对非 zip 输入不返回 error 而是抛错(translate_zip_error 漏分支),rescue 一并兜住
  defp open(binary) do
    case XlsxReader.open(binary, source: :binary) do
      {:ok, package} -> {:ok, package}
      {:error, _reason} -> {:error, "无法读取文件:仅支持 xlsx 格式(xls 请用 Excel 另存为 xlsx 后重试)"}
    end
  rescue
    _ -> {:error, "无法读取文件:仅支持 xlsx 格式(xls 请用 Excel 另存为 xlsx 后重试)"}
  end

  defp first_sheet(package) do
    case XlsxReader.sheet_names(package) do
      [name | _] ->
        case XlsxReader.sheet(package, name, number_type: String) do
          {:ok, rows} -> {:ok, rows}
          {:error, _reason} -> {:error, "工作表「#{name}」解析失败"}
        end

      [] ->
        {:error, "文件中没有工作表"}
    end
  end

  defp build_items(template, rows) do
    cols = column_indexes(template)

    items =
      rows
      |> Enum.with_index(1)
      |> Enum.drop(template.start_row - 1)
      |> Enum.reject(fn {row, _row_no} -> blank_row?(row, cols) end)
      |> Enum.map(fn {row, row_no} -> build_item(template, cols, row, row_no) end)

    cond do
      items == [] -> {:error, "没有可解析的数据行(数据起始行:第 #{template.start_row} 行)"}
      length(items) > @max_rows -> {:error, "数据行超过上限 #{@max_rows} 行,请拆分文件后分次导入"}
      true -> {:ok, items}
    end
  end

  # 模板列号字母 → 1 起的列索引;未配置的列为 nil
  defp column_indexes(template) do
    ~w(datetime_col date_col time_col income_col expense_col amount_col balance_col
       counterparty_name_col counterparty_account_col summary_col note_col)a
    |> Map.new(fn field ->
      {field,
       case Map.get(template, field) do
         nil -> nil
         letters -> col_index(letters)
       end}
    end)
  end

  defp col_index(<<c>>), do: c - ?A + 1
  defp col_index(<<a, b>>), do: (a - ?A + 1) * 26 + (b - ?A + 1)

  defp blank_row?(row, cols) do
    cols
    |> Map.values()
    |> Enum.reject(&is_nil/1)
    |> Enum.all?(fn idx -> cell(row, idx) == nil end)
  end

  # 空串/纯空白折叠为 nil;文本 trim;Date/NaiveDateTime/Time 结构原样透传
  defp cell(_row, nil), do: nil

  defp cell(row, idx) do
    case Enum.at(row, idx - 1, "") do
      "" ->
        nil

      value when is_binary(value) ->
        case String.trim(value) do
          "" -> nil
          trimmed -> trimmed
        end

      value ->
        value
    end
  end

  defp build_item(template, cols, row, row_no) do
    at = fn field -> cell(row, cols[field]) end

    {occurred_at, time_errors} = parse_occurred_at(template, at)
    {income, expense, amount_errors} = parse_amounts(template, at)
    {balance, balance_errors} = parse_balance(at.(:balance_col))

    {texts, text_errors} =
      Enum.reduce(@max_lengths, {%{}, []}, fn {field, {max, label}}, {acc, errors} ->
        case parse_text(at.(:"#{field}_col"), max, label) do
          {:ok, value} -> {Map.put(acc, field, value), errors}
          {:error, msg} -> {Map.put(acc, field, nil), errors ++ [msg]}
        end
      end)

    errors = time_errors ++ amount_errors ++ balance_errors ++ text_errors

    %{
      row_no: row_no,
      occurred_at: occurred_at,
      income: income,
      expense: expense,
      balance: balance,
      counterparty_name: texts.counterparty_name,
      counterparty_account: texts.counterparty_account,
      summary: texts.summary,
      note: texts.note,
      error: if(errors == [], do: nil, else: Enum.join(errors, ";"))
    }
  end

  ## 交易时间

  defp parse_occurred_at(%{datetime_col: col} = template, at) when not is_nil(col) do
    case at.(:datetime_col) do
      nil ->
        {nil, ["交易时间为空"]}

      %NaiveDateTime{} = ndt ->
        {to_utc(ndt), []}

      %Date{} = date ->
        {to_utc(NaiveDateTime.new!(date, ~T[00:00:00])), []}

      value when is_binary(value) ->
        case parse_by_format(@datetime_regex, template.datetime_format, value) do
          {:ok, ndt} -> {to_utc(ndt), []}
          :error -> {nil, [format_error("交易时间", value, DatetimeFormat, template.datetime_format)]}
        end

      _other ->
        {nil, ["交易时间无法识别"]}
    end
  end

  defp parse_occurred_at(template, at) do
    with {:ok, date} <- parse_date(template, at.(:date_col)),
         {:ok, time} <- parse_time(template, at.(:time_col)) do
      {to_utc(NaiveDateTime.new!(date, time)), []}
    else
      {:error, msg} -> {nil, [msg]}
    end
  end

  defp parse_date(_template, %Date{} = date), do: {:ok, date}
  defp parse_date(_template, %NaiveDateTime{} = ndt), do: {:ok, NaiveDateTime.to_date(ndt)}
  defp parse_date(_template, nil), do: {:error, "交易日期为空"}

  defp parse_date(template, value) when is_binary(value) do
    case parse_by_format(@date_regex, template.date_format, value) do
      {:ok, ndt} -> {:ok, NaiveDateTime.to_date(ndt)}
      :error -> {:error, format_error("交易日期", value, DateFormat, template.date_format)}
    end
  end

  defp parse_date(_template, _other), do: {:error, "交易日期无法识别"}

  # 时间列可省或该格空:缺省 00:00:00(spec 拍板)
  defp parse_time(_template, nil), do: {:ok, ~T[00:00:00]}
  defp parse_time(_template, %Time{} = time), do: {:ok, time}
  defp parse_time(_template, %NaiveDateTime{} = ndt), do: {:ok, NaiveDateTime.to_time(ndt)}

  defp parse_time(template, value) when is_binary(value) do
    case parse_by_format(@time_regex, template.time_format, value) do
      {:ok, ndt} -> {:ok, NaiveDateTime.to_time(ndt)}
      :error -> {:error, format_error("交易时间", value, TimeFormat, template.time_format)}
    end
  end

  defp parse_time(_template, _other), do: {:error, "交易时间无法识别"}

  defp parse_by_format(table, format, value) do
    with %Regex{} = regex <- table[format],
         %{"y" => _} = captures <- named_captures_with_defaults(regex, value),
         {:ok, date} <- captures_to_date(captures),
         {:ok, time} <- captures_to_time(captures) do
      {:ok, NaiveDateTime.new!(date, time)}
    else
      _ -> :error
    end
  end

  # 时间表的正则没有 y 捕获,补 1970-01-01 占位(调用方只取 time 部分)
  defp named_captures_with_defaults(regex, value) do
    case Regex.named_captures(regex, value) do
      nil ->
        nil

      captures ->
        Map.merge(
          %{"y" => "1970", "m" => "1", "d" => "1", "h" => "0", "mi" => "0", "s" => "0"},
          captures
        )
    end
  end

  defp captures_to_date(%{"y" => y, "m" => m, "d" => d}) do
    Date.new(String.to_integer(y), String.to_integer(m), String.to_integer(d))
  end

  defp captures_to_time(%{"h" => h, "mi" => mi, "s" => s}) do
    Time.new(String.to_integer(h), String.to_integer(mi), String.to_integer(s))
  end

  defp format_error(label, value, enum, format) do
    "#{label}「#{value}」不符合格式 #{enum.description(format)}"
  end

  # 文件时间按本地时区理解,固定偏移转 UTC 存储
  defp to_utc(%NaiveDateTime{} = ndt) do
    offset = Application.get_env(:synie_core, :bank_import_utc_offset_minutes, 480)

    ndt
    |> DateTime.from_naive!("Etc/UTC")
    |> DateTime.add(-offset * 60, :second)
  end

  ## 金额

  defp parse_amounts(%{amount_col: col}, at) when not is_nil(col) do
    case parse_decimal(at.(:amount_col)) do
      {:ok, nil} ->
        {nil, nil, ["金额为空"]}

      {:ok, amount} ->
        case Decimal.compare(amount, 0) do
          :gt -> {amount, nil, []}
          :lt -> {nil, Decimal.abs(amount), []}
          :eq -> {nil, nil, ["金额为零"]}
        end

      {:error, value} ->
        {nil, nil, ["金额「#{value}」无法解析"]}
    end
  end

  defp parse_amounts(_template, at) do
    with {:ok, income} <- signed_amount(at.(:income_col), "收入"),
         {:ok, expense} <- signed_amount(at.(:expense_col), "支出") do
      # 0 视为未填:部分银行导出在对侧列填 0.00
      income = positive_or_nil(income)
      expense = positive_or_nil(expense)

      cond do
        is_nil(income) and is_nil(expense) -> {nil, nil, ["收入/支出均为空"]}
        not is_nil(income) and not is_nil(expense) -> {nil, nil, ["收入与支出同时有值"]}
        true -> {income, expense, []}
      end
    else
      {:error, msg} -> {nil, nil, [msg]}
    end
  end

  defp signed_amount(value, label) do
    case parse_decimal(value) do
      {:ok, nil} ->
        {:ok, nil}

      {:ok, amount} ->
        if Decimal.compare(amount, 0) == :lt do
          {:error, "#{label}为负数,请检查金额列配置(负值请用带符号金额列模式)"}
        else
          {:ok, amount}
        end

      {:error, raw} ->
        {:error, "#{label}「#{raw}」无法解析"}
    end
  end

  defp positive_or_nil(nil), do: nil
  defp positive_or_nil(amount), do: if(Decimal.compare(amount, 0) == :gt, do: amount, else: nil)

  defp parse_balance(value) do
    case parse_decimal(value) do
      {:ok, balance} -> {balance, []}
      {:error, raw} -> {nil, ["余额「#{raw}」无法解析"]}
    end
  end

  defp parse_decimal(nil), do: {:ok, nil}

  defp parse_decimal(value) when is_binary(value) do
    normalized =
      value
      |> String.replace([",", "，", " ", "¥", "￥"], "")
      |> String.trim_leading("+")

    case Decimal.parse(normalized) do
      {decimal, ""} -> {:ok, decimal}
      _ -> {:error, value}
    end
  end

  # 日期结构落进金额列之类的错配,报原值
  defp parse_decimal(value), do: {:error, inspect(value)}

  ## 文本

  defp parse_text(nil, _max, _label), do: {:ok, nil}

  defp parse_text(value, max, label) do
    text = to_text(value)

    if String.length(text) > max do
      {:error, "#{label}超过 #{max} 字"}
    else
      {:ok, text}
    end
  end

  defp to_text(value) when is_binary(value), do: value
  defp to_text(%Date{} = date), do: Date.to_string(date)
  defp to_text(%NaiveDateTime{} = ndt), do: NaiveDateTime.to_string(ndt)
  defp to_text(%Time{} = time), do: Time.to_string(time)
end
