defmodule SynieCore.PrintingFixture do
  @moduledoc """
  打印引擎测试夹具：手拼 OOXML，支持 sharedStrings、mergeCells、
  打印区域、多 sheet、pageSetup，供 Renderer 单测使用。
  """

  @ns_main "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
  @ns_r "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
  @ns_pkg_rel "http://schemas.openxmlformats.org/package/2006/relationships"
  @ns_ct "http://schemas.openxmlformats.org/package/2006/content-types"
  @ns_od_rel "http://schemas.openxmlformats.org/officeDocument/2006/relationships"

  @doc """
  构建模板 xlsx。

  ## opts
    * `:sheets` — `[%{name: "Sheet1", rows: [[cell, ...], ...], merges: ["A1:B1"], print_area: "A1:D10"}]`
      cell 为 string（inlineStr）或 `{:s, string}`（走 sharedStrings）或 number
    * 简写：`:rows` 只建单 sheet（可用 `:sheet_name`、`:merges`、`:print_area`、`:page_setup`）
  """
  def build(opts \\ []) do
    sheets =
      case Keyword.get(opts, :sheets) do
        nil ->
          [
            %{
              name: Keyword.get(opts, :sheet_name, "Sheet1"),
              rows: Keyword.fetch!(opts, :rows),
              merges: Keyword.get(opts, :merges, []),
              print_area: Keyword.get(opts, :print_area),
              page_setup: Keyword.get(opts, :page_setup, true)
            }
          ]

        list when is_list(list) ->
          list
      end

    {shared_list, sheets_xml} = materialize_sheets(sheets)
    shared_xml = shared_strings_xml(shared_list)

    sheet_files =
      sheets_xml
      |> Enum.with_index(1)
      |> Enum.map(fn {xml, i} -> {~c"xl/worksheets/sheet#{i}.xml", xml} end)

    overrides =
      sheets_xml
      |> Enum.with_index(1)
      |> Enum.map(fn {_, i} ->
        ~s|<Override PartName="/xl/worksheets/sheet#{i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>|
      end)
      |> Enum.join("\n")

    defined_names =
      sheets
      |> Enum.with_index(1)
      |> Enum.flat_map(fn {s, i} ->
        case s[:print_area] || s["print_area"] do
          nil ->
            []

          area ->
            name = s[:name] || s["name"] || "Sheet#{i}"
            [
              ~s|<definedName name="_xlnm.Print_Area" localSheetId="#{i - 1}">'#{xml_escape(name)}'!#{area}</definedName>|
            ]
        end
      end)

    defined_names_xml =
      if defined_names == [] do
        ""
      else
        "<definedNames>#{Enum.join(defined_names)}</definedNames>"
      end

    sheet_entries =
      sheets
      |> Enum.with_index(1)
      |> Enum.map(fn {s, i} ->
        name = s[:name] || s["name"] || "Sheet#{i}"
        ~s|<sheet name="#{xml_escape(name)}" sheetId="#{i}" r:id="rId#{i}"/>|
      end)
      |> Enum.join()

    rels =
      sheets
      |> Enum.with_index(1)
      |> Enum.map(fn {_, i} ->
        ~s|<Relationship Id="rId#{i}" Type="#{@ns_od_rel}/worksheet" Target="worksheets/sheet#{i}.xml"/>|
      end)
      |> Enum.join()

    # rId for styles after sheets
    styles_rid = length(sheets) + 1
    shared_rid = length(sheets) + 2

    workbook = """
    <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <workbook xmlns="#{@ns_main}" xmlns:r="#{@ns_r}">
      <sheets>#{sheet_entries}</sheets>
      #{defined_names_xml}
    </workbook>
    """

    workbook_rels = """
    <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <Relationships xmlns="#{@ns_pkg_rel}">
      #{rels}
      <Relationship Id="rId#{styles_rid}" Type="#{@ns_od_rel}/styles" Target="styles.xml"/>
      <Relationship Id="rId#{shared_rid}" Type="#{@ns_od_rel}/sharedStrings" Target="sharedStrings.xml"/>
    </Relationships>
    """

    content_types = """
    <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <Types xmlns="#{@ns_ct}">
      <Default Extension="xml" ContentType="application/xml"/>
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
      #{overrides}
      <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
      <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
    </Types>
    """

    root_rels = """
    <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <Relationships xmlns="#{@ns_pkg_rel}">
      <Relationship Id="rId1" Type="#{@ns_od_rel}/officeDocument" Target="xl/workbook.xml"/>
    </Relationships>
    """

    styles = """
    <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <styleSheet xmlns="#{@ns_main}">
      <fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>
      <fills count="1"><fill><patternFill patternType="none"/></fill></fills>
      <borders count="1"><border/></borders>
      <cellStyleXfs count="1"><xf/></cellStyleXfs>
      <cellXfs count="1"><xf xfId="0"/></cellXfs>
    </styleSheet>
    """

    files =
      [
        {~c"[Content_Types].xml", content_types},
        {~c"_rels/.rels", root_rels},
        {~c"xl/workbook.xml", workbook},
        {~c"xl/_rels/workbook.xml.rels", workbook_rels},
        {~c"xl/styles.xml", styles},
        {~c"xl/sharedStrings.xml", shared_xml}
      ] ++ sheet_files

    {:ok, {_name, binary}} = :zip.create(~c"print_fixture.xlsx", files, [:memory])
    binary
  end

  defp materialize_sheets(sheets) do
    # collect shared strings in order of first appearance
    acc_shared = :ets.new(:ss, [:ordered_set, :private])

    try do
      xmls =
        Enum.map(sheets, fn sheet ->
          rows = sheet[:rows] || sheet["rows"] || []
          merges = sheet[:merges] || sheet["merges"] || []
          page_setup? = Map.get(sheet, :page_setup, Map.get(sheet, "page_setup", true))
          sheet_xml(rows, merges, page_setup?, acc_shared)
        end)

      shared_list =
        :ets.tab2list(acc_shared)
        |> Enum.sort_by(fn {_s, idx} -> idx end)
        |> Enum.map(fn {s, _} -> s end)

      {shared_list, xmls}
    after
      :ets.delete(acc_shared)
    end
  end

  defp sheet_xml(rows, merges, page_setup?, acc_shared) do
    row_xmls =
      rows
      |> Enum.with_index(1)
      |> Enum.map(fn {cells, r} ->
        cells_xml =
          cells
          |> Enum.with_index(0)
          |> Enum.map(fn {cell, col} ->
            ref = col_letters(col) <> Integer.to_string(r)
            cell_xml(ref, cell, acc_shared)
          end)
          |> Enum.join()

        ~s|<row r="#{r}">#{cells_xml}</row>|
      end)
      |> Enum.join()

    last_row = max(length(rows), 1)
    last_col = rows |> Enum.map(&length/1) |> Enum.max(fn -> 1 end)
    dim = "A1:#{col_letters(last_col - 1)}#{last_row}"

    merge_xml =
      case merges do
        [] ->
          ""

        list ->
          inner =
            Enum.map_join(list, fn ref -> ~s|<mergeCell ref="#{ref}"/>| end)

          ~s|<mergeCells count="#{length(list)}">#{inner}</mergeCells>|
      end

    page =
      if page_setup? do
        ~s|<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>| <>
          ~s|<pageSetup paperSize="9" orientation="portrait"/>|
      else
        ""
      end

    """
    <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <worksheet xmlns="#{@ns_main}" xmlns:r="#{@ns_r}">
      <dimension ref="#{dim}"/>
      <sheetData>#{row_xmls}</sheetData>
      #{merge_xml}
      #{page}
    </worksheet>
    """
  end

  defp cell_xml(ref, {:s, text}, acc_shared) when is_binary(text) do
    idx = shared_index(acc_shared, text)
    ~s|<c r="#{ref}" t="s"><v>#{idx}</v></c>|
  end

  defp cell_xml(ref, text, _acc) when is_binary(text) do
    ~s|<c r="#{ref}" t="inlineStr"><is><t>#{xml_escape(text)}</t></is></c>|
  end

  defp cell_xml(ref, n, _acc) when is_number(n) do
    ~s|<c r="#{ref}"><v>#{n}</v></c>|
  end

  defp cell_xml(ref, nil, _acc), do: ~s|<c r="#{ref}"/>|

  defp shared_index(tab, text) do
    case :ets.lookup(tab, text) do
      [{^text, idx}] ->
        idx

      [] ->
        idx = :ets.info(tab, :size)
        true = :ets.insert(tab, {text, idx})
        idx
    end
  end

  defp shared_strings_xml([]) do
    """
    <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <sst xmlns="#{@ns_main}" count="0" uniqueCount="0"></sst>
    """
  end

  defp shared_strings_xml(list) do
    sis =
      Enum.map_join(list, fn s ->
        ~s|<si><t>#{xml_escape(s)}</t></si>|
      end)

    """
    <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <sst xmlns="#{@ns_main}" count="#{length(list)}" uniqueCount="#{length(list)}">#{sis}</sst>
    """
  end

  def col_letters(n) when n >= 0 do
    do_col(n, "")
  end

  defp do_col(n, acc) when n < 26, do: <<?A + n>> <> acc

  defp do_col(n, acc) do
    do_col(div(n, 26) - 1, <<?A + rem(n, 26)>> <> acc)
  end

  def xml_escape(s) do
    s
    |> String.replace("&", "&amp;")
    |> String.replace("<", "&lt;")
    |> String.replace(">", "&gt;")
    |> String.replace("\"", "&quot;")
  end

  @doc "从渲染后的 xlsx 读第一个 sheet 的行（字符串化）。"
  def read_first_sheet(binary) do
    {:ok, pkg} = XlsxReader.open(binary, source: :binary)
    [name | _] = XlsxReader.sheet_names(pkg)
    {:ok, rows} = XlsxReader.sheet(pkg, name, number_type: String)
    rows
  end

  @doc "读全部 sheet 名与行。"
  def read_all_sheets(binary) do
    {:ok, pkg} = XlsxReader.open(binary, source: :binary)

    for name <- XlsxReader.sheet_names(pkg) do
      {:ok, rows} = XlsxReader.sheet(pkg, name, number_type: String)
      {name, rows}
    end
  end

  @doc "解包取某 part 原始 XML 字符串。"
  def part(binary, path) when is_binary(path) do
    {:ok, files} = :zip.extract(binary, [:memory])
    path_c = String.to_charlist(path)

    case List.keyfind(files, path_c, 0) do
      {_, content} -> content
      nil -> nil
    end
  end
end
