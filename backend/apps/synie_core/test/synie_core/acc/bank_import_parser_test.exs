defmodule SynieCore.Acc.BankImportParserTest do
  use ExUnit.Case, async: true

  alias SynieCore.Acc.BankImport.Parser
  alias SynieCore.XlsxFixture

  # 模板字段的裸 map 即可满足解析器取值(资源结构体的字段子集)
  @base_template %{
    start_row: 2,
    datetime_col: nil,
    datetime_format: nil,
    date_col: nil,
    date_format: nil,
    time_col: nil,
    time_format: nil,
    income_col: nil,
    expense_col: nil,
    amount_col: nil,
    balance_col: nil,
    counterparty_name_col: nil,
    counterparty_account_col: nil,
    summary_col: nil,
    note_col: nil
  }

  defp template(overrides), do: Map.merge(@base_template, overrides)

  # 双列时间 + 双列金额的常用模板:A 日期 B 时间 C 收入 D 支出 E 余额 F 户名 G 摘要
  defp double_template(overrides \\ %{}) do
    template(
      Map.merge(
        %{
          date_col: "A",
          date_format: :ymd_dash,
          time_col: "B",
          time_format: :hms,
          income_col: "C",
          expense_col: "D",
          balance_col: "E",
          counterparty_name_col: "F",
          summary_col: "G"
        },
        overrides
      )
    )
  end

  defp parse!(template, rows) do
    {:ok, items} = Parser.parse(template, XlsxFixture.build(rows))
    items
  end

  @header ["日期", "时间", "收入", "支出", "余额", "对方户名", "摘要"]

  test "双列时间双列金额:文本单元格按格式解析,本地时间按偏移转 UTC" do
    [item] =
      parse!(double_template(), [
        @header,
        ["2026-07-01", "10:30:00", "1,234.56", "", "5,000.00", "某某公司", "货款"]
      ])

    assert item.row_no == 2
    # UTC+8:本地 10:30 → UTC 02:30
    assert item.occurred_at == ~U[2026-07-01 02:30:00Z]
    assert Decimal.equal?(item.income, Decimal.new("1234.56"))
    assert item.expense == nil
    assert Decimal.equal?(item.balance, Decimal.new("5000.00"))
    assert item.counterparty_name == "某某公司"
    assert item.summary == "货款"
    assert item.note == nil
    assert item.error == nil
  end

  test "时间列缺省按 00:00:00(跨日转 UTC)" do
    tpl = double_template(%{time_col: nil, time_format: nil})
    [item] = parse!(tpl, [@header, ["2026-07-01", nil, "10", "", "", "", ""]])
    assert item.occurred_at == ~U[2026-06-30 16:00:00Z]
    assert item.error == nil
  end

  test "原生日期/时间样式单元格优先于格式枚举" do
    # 格式配置故意与单元格文本形态不符,原生单元格仍应解析成功
    [item] =
      parse!(double_template(%{date_format: :mdy_slash, time_format: :hms_cn}), [
        @header,
        [~D[2026-07-01], ~T[10:30:00], "100", "", "", "", ""]
      ])

    assert item.occurred_at == ~U[2026-07-01 02:30:00Z]
    assert item.error == nil
  end

  test "单列日期时间:文本与原生单元格" do
    tpl = template(%{datetime_col: "A", datetime_format: :ymd_dash_hms, income_col: "B"})

    [text_item, native_item] =
      parse!(tpl, [
        ["时间", "收入"],
        ["2026-07-01 10:30:05", "1"],
        [~N[2026-07-02 08:00:00], "2"]
      ])

    assert text_item.occurred_at == ~U[2026-07-01 02:30:05Z]
    assert native_item.occurred_at == ~U[2026-07-02 00:00:00Z]
  end

  test "日期格式取样:compact/中文/mdy/dmy" do
    cases = [
      {:ymd_compact, "20260701"},
      {:ymd_cn, "2026年7月1日"},
      {:mdy_slash, "7/1/2026"},
      {:dmy_slash, "1/7/2026"}
    ]

    for {format, text} <- cases do
      tpl = double_template(%{date_format: format, time_col: nil, time_format: nil})
      [item] = parse!(tpl, [@header, [text, nil, "1", "", "", "", ""]])
      assert item.occurred_at == ~U[2026-06-30 16:00:00Z], "格式 #{format} 应解析 #{text}"
    end
  end

  test "日期不符合格式:字段留空并报行错,其余字段照常" do
    [item] = parse!(double_template(), [@header, ["07/01/2026", "10:00:00", "1", "", "", "", "备注在摘要"]])
    assert item.occurred_at == nil
    assert item.error =~ "不符合格式 YYYY-MM-DD"
    assert Decimal.equal?(item.income, Decimal.new("1"))
    assert item.summary == "备注在摘要"
  end

  test "带符号单列金额:正收负支,零报错" do
    tpl = template(%{date_col: "A", date_format: :ymd_dash, amount_col: "B"})

    [pos, neg, zero] =
      parse!(tpl, [
        ["日期", "金额"],
        ["2026-07-01", "100"],
        ["2026-07-01", "-50.5"],
        ["2026-07-01", "0"]
      ])

    assert Decimal.equal?(pos.income, Decimal.new("100")) and pos.expense == nil
    assert Decimal.equal?(neg.expense, Decimal.new("50.5")) and neg.income == nil
    assert zero.error =~ "金额为零"
  end

  test "双列金额错误矩阵:双填/双空/负数/一侧填零" do
    [both, empty, negative, zero_side] =
      parse!(double_template(), [
        @header,
        ["2026-07-01", "10:00:00", "1", "2", "", "", ""],
        ["2026-07-01", "10:00:00", "", "", "", "", ""],
        ["2026-07-01", "10:00:00", "-1", "", "", "", ""],
        ["2026-07-01", "10:00:00", "0.00", "3", "", "", ""]
      ])

    assert both.error =~ "收入与支出同时有值"
    assert empty.error =~ "收入/支出均为空"
    assert negative.error =~ "收入为负数"
    assert zero_side.error == nil
    assert Decimal.equal?(zero_side.expense, Decimal.new("3"))
  end

  test "数字单元格按原始字符串取值(长账号不失真)" do
    tpl = double_template(%{counterparty_account_col: "F", counterparty_name_col: nil})

    [item] =
      parse!(tpl, [@header, ["2026-07-01", "10:00:00", 100.5, nil, nil, "6222020200112233445", ""]])

    assert Decimal.equal?(item.income, Decimal.new("100.5"))
    assert item.counterparty_account == "6222020200112233445"
  end

  test "余额无法解析与超长摘要报行错" do
    long = String.duplicate("长", 256)

    [item] = parse!(double_template(), [@header, ["2026-07-01", "10:00:00", "1", "", "abc", "", long]])

    assert item.error =~ "余额「abc」无法解析"
    assert item.error =~ "摘要超过 255 字"
    assert item.balance == nil
    assert item.summary == nil
  end

  test "所配列全空的行静默跳过(未配置列有值不算)" do
    tpl = double_template(%{note_col: nil})

    items =
      parse!(tpl, [
        @header,
        ["2026-07-01", "10:00:00", "1", "", "", "", ""],
        [nil, nil, nil, nil, nil, nil, nil, "H 列有值但未配置"],
        ["2026-07-02", "11:00:00", "2", "", "", "", ""]
      ])

    assert Enum.map(items, & &1.row_no) == [2, 4]
  end

  test "零数据行与超上限报记录级错误" do
    assert {:error, msg} = Parser.parse(double_template(), XlsxFixture.build([@header]))
    assert msg =~ "没有可解析的数据行"

    many = [@header | List.duplicate(["2026-07-01", "10:00:00", "1", "", "", "", ""], 5001)]
    assert {:error, msg} = Parser.parse(double_template(), XlsxFixture.build(many))
    assert msg =~ "超过上限 5000 行"
  end

  test "非 xlsx 文件报可读错误" do
    assert {:error, msg} = Parser.parse(double_template(), "这不是 zip")
    assert msg =~ "仅支持 xlsx"
  end
end
