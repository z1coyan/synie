defmodule SynieCore.Hr.AttendanceImportParserTest do
  use ExUnit.Case, async: true

  alias SynieCore.Hr.AttendanceImport.Parser

  test "tab 分隔多列:只取编号+时间,其余列忽略;本地时间按 +08 转 UTC" do
    {:ok, result} = Parser.parse("1\t2026-07-01 08:30:15\t1\t0\t1\t0\r\n")

    assert result.total_rows == 1
    assert result.bad_rows == 0
    assert result.dup_rows == 0
    assert [%{attendance_no: "1", punched_at: at}] = result.rows
    assert at == ~U[2026-07-01 00:30:15Z]
  end

  test "空白分隔同样可解析(编号原样保留,不去前导零)" do
    {:ok, result} = Parser.parse("007  2026-07-01 23:59:59\n")

    assert [%{attendance_no: "007", punched_at: ~U[2026-07-01 15:59:59Z]}] = result.rows
  end

  test "坏行计数跳过:列数不足/时间非法/非法编码" do
    content = "1\t2026-07-01 08:00:00\n仅一列\n2\t2026-13-40 99:00:00\n" <> <<0xFF, 0xFE>> <> "\n"

    {:ok, result} = Parser.parse(content)

    assert result.total_rows == 4
    assert result.bad_rows == 3
    assert length(result.rows) == 1
  end

  test "文件内同 (编号,时刻) 重复行计数跳过,隔秒连按保留" do
    content = """
    1\t2026-07-01 08:00:00
    1\t2026-07-01 08:00:00
    1\t2026-07-01 08:00:05
    """

    {:ok, result} = Parser.parse(content)

    assert result.dup_rows == 1
    assert length(result.rows) == 2
  end

  test "纯空白行不计入总行数" do
    {:ok, result} = Parser.parse("1\t2026-07-01 08:00:00\n\n \t \n")

    assert result.total_rows == 1
  end

  test "空文件与全坏行报记录级错误" do
    assert {:error, "文件为空" <> _} = Parser.parse("")
    assert {:error, "未解析到有效打卡行" <> _} = Parser.parse("garbage\nmore garbage\n")
  end
end
