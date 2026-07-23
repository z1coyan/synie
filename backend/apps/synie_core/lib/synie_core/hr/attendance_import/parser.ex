defmodule SynieCore.Hr.AttendanceImport.Parser do
  @moduledoc """
  解析 ZKTeco 考勤机 .dat 打卡文本:`parse(binary)` 返回
  `{:ok, %{rows: 行, total_rows: n, bad_rows: n, dup_rows: n}}`(rows 已文件内去重)
  或 `{:error, 记录级原因}`(空文件/全坏行/超上限)。

  取值规则(spec 拍板,见 docs/adr/2026-07-15-attendance-import.md):

    * 行格式:考勤机编号 + 打卡时间 `YYYY-MM-DD HH:MM:SS`,tab 或连续空白分隔;
      其余列(机号/状态键/验证方式)一律忽略不存,原始 .dat 挂批次可回溯;
    * 编号原样匹配不做归一(不去前导零:归一有把「001」「1」两个员工混为一人的风险);
    * 坏行(列数不足/时间解析失败/非法编码)计数跳过,不阻断;
    * 同 (编号, 时刻) 的文件内重复行计数跳过(员工连按考勤机);
    * 本地时间按固定偏移转 UTC(`:attendance_import_utc_offset_minutes`,默认
      480 即 UTC+8,国内无夏令时不引 tzdata,照银行流水导入先例)。
  """

  @max_rows 100_000

  def parse(binary) when is_binary(binary) do
    lines = String.split(binary, ["\r\n", "\n", "\r"], trim: true)
    lines = Enum.reject(lines, &blank?/1)
    total = length(lines)

    cond do
      total == 0 ->
        {:error, "文件为空,未解析到打卡行"}

      total > @max_rows ->
        {:error, "文件超过 #{@max_rows} 行上限,请拆分后导入"}

      true ->
        collect(lines, total)
    end
  end

  defp collect(lines, total) do
    {rows, _seen, bad, dup} =
      Enum.reduce(lines, {[], MapSet.new(), 0, 0}, fn line, {rows, seen, bad, dup} ->
        case parse_line(line) do
          {:ok, %{attendance_no: no, punched_at: at} = row} ->
            key = {no, at}

            if MapSet.member?(seen, key),
              do: {rows, seen, bad, dup + 1},
              else: {[row | rows], MapSet.put(seen, key), bad, dup}

          :error ->
            {rows, seen, bad + 1, dup}
        end
      end)

    if rows == [],
      do: {:error, "未解析到有效打卡行(共 #{total} 行均无法识别)"},
      else: {:ok, %{rows: Enum.reverse(rows), total_rows: total, bad_rows: bad, dup_rows: dup}}
  end

  defp parse_line(line) do
    with true <- String.valid?(line),
         [no, date, time | _rest] <- String.split(line),
         true <- byte_size(no) in 1..64,
         {:ok, naive} <- NaiveDateTime.from_iso8601(date <> " " <> time) do
      {:ok, %{attendance_no: no, punched_at: to_utc(naive)}}
    else
      _ -> :error
    end
  end

  defp to_utc(naive) do
    offset = Application.get_env(:synie_core, :attendance_import_utc_offset_minutes, 480)

    naive
    |> DateTime.from_naive!("Etc/UTC")
    |> DateTime.add(-offset * 60, :second)
  end

  defp blank?(line), do: :binary.replace(line, ["\t", " "], "", [:global]) == ""
end
