defmodule SynieCore.XlsxFixture do
  @moduledoc """
  测试用最小 xlsx 生成器::zip 手拼 OOXML(xlsx_reader 只要求
  xl/workbook.xml 与其 rels,字符串走 inlineStr 免 sharedStrings)。

  单元格按 Elixir 值编码:
    * binary → 内联字符串
    * integer/float/Decimal → 数值单元格
    * %Date{} / %NaiveDateTime{} / %Time{} → 序列数 + 对应内置日期/时间样式
      (解析器的「原生日期单元格优先」路径靠它触发)
    * nil → 跳过(稀疏单元格,读回为空串)
  """

  # 内置 numFmtId:14 日期、22 日期时间、20 时间;样式索引 s= 与 cellXfs 顺序对应
  @style_date 1
  @style_datetime 2
  @style_time 3

  @serial_base ~D[1899-12-30]

  @doc "rows 为单元格值列表的列表(1 行 1 列表),返回 xlsx 二进制。"
  def build(rows, opts \\ []) do
    sheet_name = Keyword.get(opts, :sheet_name, "Sheet1")

    files = [
      {~c"[Content_Types].xml", content_types_xml()},
      # xlsx_reader 不看根 rels,但 LibreOffice 等严格实现需要(测试内转 xls 用)
      {~c"_rels/.rels", root_rels_xml()},
      {~c"xl/workbook.xml", workbook_xml(sheet_name)},
      {~c"xl/_rels/workbook.xml.rels", workbook_rels_xml()},
      {~c"xl/styles.xml", styles_xml()},
      {~c"xl/worksheets/sheet1.xml", sheet_xml(rows)}
    ]

    {:ok, {_name, binary}} = :zip.create(~c"fixture.xlsx", files, [:memory])
    binary
  end

  defp content_types_xml do
    """
    <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="xml" ContentType="application/xml"/>
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Override PartName="/xl/workbook.xml"
        ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
      <Override PartName="/xl/worksheets/sheet1.xml"
        ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
      <Override PartName="/xl/styles.xml"
        ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
    </Types>
    """
  end

  defp root_rels_xml do
    """
    <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1"
        Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"
        Target="xl/workbook.xml"/>
    </Relationships>
    """
  end

  defp workbook_xml(sheet_name) do
    """
    <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
      xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
      <sheets><sheet name="#{xml_escape(sheet_name)}" sheetId="1" r:id="rId1"/></sheets>
    </workbook>
    """
  end

  defp workbook_rels_xml do
    """
    <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1"
        Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"
        Target="worksheets/sheet1.xml"/>
      <Relationship Id="rId2"
        Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles"
        Target="styles.xml"/>
    </Relationships>
    """
  end

  defp styles_xml do
    """
    <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
      <cellXfs count="4">
        <xf numFmtId="0"/>
        <xf numFmtId="14"/>
        <xf numFmtId="22"/>
        <xf numFmtId="20"/>
      </cellXfs>
    </styleSheet>
    """
  end

  defp sheet_xml(rows) do
    body =
      rows
      |> Enum.with_index(1)
      |> Enum.map_join("\n", fn {cells, row_no} -> row_xml(cells, row_no) end)

    """
    <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
      <sheetData>
      #{body}
      </sheetData>
    </worksheet>
    """
  end

  defp row_xml(cells, row_no) do
    body =
      cells
      |> Enum.with_index(1)
      |> Enum.map_join("", fn {value, col_no} -> cell_xml(value, row_no, col_no) end)

    ~s(<row r="#{row_no}">#{body}</row>)
  end

  defp cell_xml(nil, _row_no, _col_no), do: ""

  defp cell_xml(value, row_no, col_no) do
    ref = ~s( r="#{col_letter(col_no)}#{row_no}")

    case value do
      text when is_binary(text) ->
        ~s(<c#{ref} t="inlineStr"><is><t>#{xml_escape(text)}</t></is></c>)

      %Date{} = date ->
        ~s(<c#{ref} s="#{@style_date}"><v>#{Date.diff(date, @serial_base)}</v></c>)

      %NaiveDateTime{} = ndt ->
        days = Date.diff(NaiveDateTime.to_date(ndt), @serial_base)
        fraction = Time.to_seconds_after_midnight(NaiveDateTime.to_time(ndt)) |> elem(0)
        ~s(<c#{ref} s="#{@style_datetime}"><v>#{days + fraction / 86_400}</v></c>)

      %Time{} = time ->
        fraction = Time.to_seconds_after_midnight(time) |> elem(0)
        ~s(<c#{ref} s="#{@style_time}"><v>#{fraction / 86_400}</v></c>)

      number when is_integer(number) or is_float(number) ->
        ~s(<c#{ref}><v>#{number}</v></c>)

      %Decimal{} = decimal ->
        ~s(<c#{ref}><v>#{Decimal.to_string(decimal)}</v></c>)
    end
  end

  defp col_letter(n) when n <= 26, do: <<?A + n - 1>>
  defp col_letter(n), do: <<?A + div(n - 1, 26) - 1, ?A + rem(n - 1, 26)>>

  defp xml_escape(text) do
    text
    |> String.replace("&", "&amp;")
    |> String.replace("<", "&lt;")
    |> String.replace(">", "&gt;")
  end
end
