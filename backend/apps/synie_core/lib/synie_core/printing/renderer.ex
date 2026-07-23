defmodule SynieCore.Printing.RenderError do
  @moduledoc "模板结构不符合预期（非 zip、缺 part、行缺 r 属性等）时抛出。"
  defexception [:message]
end

defmodule SynieCore.Printing.Renderer do
  @moduledoc """
  纯 Elixir xlsx 模板填充引擎（打印模板核心，决策见 docs/adr/2026-07-23-print-template.md）。

  原则：最小侵入 XML 操作——解包 zip、改写第一个 sheet 的 XML、重打包，其余 part
  原样拷贝。含 `${...}` 占位符的单元格统一改写为 inline string 落值（绕开
  sharedStrings 索引维护）；值一律按文本写入，显示格式由单元格自身 Excel 格式决定。

  只处理工作簿第一个 sheet 作为模板体，其余 sheet 原样保留。

  已知边界（由模板制作约定规避，见 ADR）：
    * 明细模板行不参与跨行合并单元格（跨明细行的 mergeCell 顺移结果未定义）
    * 单元格公式（`<f>`）内的引用不随行复制/行顺移调整
    * 批量打印时模板的 conditionalFormatting / autoFilter / dataValidation 等
      只对首个模板块生效（mergeCells / rowBreaks / 打印区域按块复制）
  """

  alias SynieCore.Printing.RenderError

  @type doc :: %{
          fields: %{String.t() => String.t()},
          loops: %{String.t() => [%{String.t() => String.t()}]}
        }

  @placeholder ~r/\$\{([^{}]+)\}/
  @row_re ~r/<row\b[^>]*?(?:\/>|>[\s\S]*?<\/row>)/
  @cell_re ~r/<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/
  @merge_re ~r/<mergeCells\b[^>]*?(?:\/>|>[\s\S]*?<\/mergeCells>)/
  @brks_re ~r/<rowBreaks\b[^>]*?(?:\/>|>[\s\S]*?<\/rowBreaks>)/

  # A1 / $A$1 / 整行 1:5：可选列字母 + 行号
  @ref_re ~r/(?<![A-Za-z0-9])(\$?)([A-Za-z]{0,3})(\$?)(\d+)/

  ## 公共 API

  @doc "打印用：单 sheet 顺序铺 N 份模板块，块间插入分页符（row break）。docs 长度 1 即单条打印。"
  @spec render_pages(binary(), [doc()]) :: {:ok, binary()} | {:error, term()}
  def render_pages(template, docs) when is_binary(template) and is_list(docs) do
    run(fn ->
      if docs == [] do
        {:error, :empty_docs}
      else
        with {:ok, pkg} <- open_package(template), do: do_render_pages(pkg, docs)
      end
    end)
  end

  @doc "导出用：每份 doc 一个 sheet（sheet 名做 31 字符截断、非法字符替换与去重）。"
  @spec render_sheets(binary(), [{String.t(), doc()}]) :: {:ok, binary()} | {:error, term()}
  def render_sheets(template, named_docs) when is_binary(template) and is_list(named_docs) do
    run(fn ->
      if named_docs == [] do
        {:error, :empty_docs}
      else
        with {:ok, pkg} <- open_package(template), do: do_render_sheets(pkg, named_docs)
      end
    end)
  end

  @doc """
  上传校验用：提取模板第一个 sheet 中全部占位符。
  无点号的进 `fields`；含点号的按首段归组进 `nested`（如 `%{"company" => ["name"], "items" => ["qty"]}`），
  首段是关联还是循环区由 FieldCatalog 按资源语义判定。均去重排序。
  """
  @spec extract_placeholders(binary()) ::
          {:ok, %{fields: [String.t()], nested: %{String.t() => [String.t()]}}} | {:error, term()}
  def extract_placeholders(template) when is_binary(template) do
    run(fn ->
      with {:ok, pkg} <- open_package(template) do
        sheet = pkg.map[pkg.sheet_path]

        sheet_texts =
          @cell_re
          |> Regex.scan(sheet)
          |> Enum.map(fn [cell] -> cell_text(cell, pkg.shared) end)
          |> Enum.filter(&is_binary/1)

        names =
          (sheet_texts ++ pkg.shared)
          |> Enum.flat_map(&Regex.scan(@placeholder, &1))
          |> Enum.map(fn [_, name] -> name end)

        {dotted, plain} = Enum.split_with(names, &String.contains?(&1, "."))

        nested =
          dotted
          |> Enum.group_by(
            fn name -> name |> String.split(".", parts: 2) |> hd() end,
            fn name -> name |> String.split(".", parts: 2) |> List.last() end
          )
          |> Map.new(fn {k, v} -> {k, v |> Enum.uniq() |> Enum.sort()} end)

        {:ok, %{fields: plain |> Enum.uniq() |> Enum.sort(), nested: nested}}
      end
    end)
  end

  defp run(fun) do
    fun.()
  rescue
    e in RenderError -> {:error, {:invalid_template, e.message}}
  end

  ## 包解析

  defp open_package(template) do
    with {:ok, files} <- unzip(template),
         map = Map.new(files, fn {name, content} -> {to_string(name), content} end),
         {:ok, wb} <- fetch_part(map, "xl/workbook.xml"),
         {:ok, rels_xml} <- fetch_part(map, "xl/_rels/workbook.xml.rels") do
      rels = parse_rels(rels_xml)

      case parse_wb_sheets(wb) do
        [] ->
          {:error, {:invalid_template, "workbook 中没有 sheet"}}

        [first | _] = sheets ->
          path = resolve_path(rels[first.rid])

          if path && Map.has_key?(map, path) do
            {:ok,
             %{
               files: files,
               map: map,
               wb: wb,
               sheets: sheets,
               rels: rels,
               sheet_path: path,
               shared: shared_strings(map)
             }}
          else
            {:error, {:invalid_template, "找不到第一个 sheet 对应的 part"}}
          end
      end
    end
  end

  defp unzip(binary) do
    case :zip.extract(binary, [:memory]) do
      {:ok, files} -> {:ok, files}
      {:error, _} -> {:error, {:invalid_template, "不是有效的 xlsx（zip）文件"}}
    end
  rescue
    _ -> {:error, {:invalid_template, "不是有效的 xlsx（zip）文件"}}
  end

  defp fetch_part(map, path) do
    case Map.fetch(map, path) do
      {:ok, v} -> {:ok, v}
      :error -> {:error, {:invalid_template, "缺少 part: #{path}"}}
    end
  end

  defp parse_rels(xml) do
    ~r/Id="([^"]+)"[^>]*Target="([^"]+)"/
    |> Regex.scan(xml)
    |> Map.new(fn [_, id, target] -> {id, target} end)
  end

  defp parse_wb_sheets(wb) do
    ~r/<sheet\b[^>]*>/
    |> Regex.scan(wb)
    |> Enum.map(fn [tag] ->
      name = attr(tag, "name")
      rid = attr(tag, "r:id") || attr(tag, "id")
      sheet_id = attr(tag, "sheetId")
      %{name: name, rid: rid, sheet_id: sheet_id, tag: tag}
    end)
    |> Enum.filter(&(&1.rid && &1.name))
  end

  defp resolve_path(nil), do: nil

  defp resolve_path(target) do
    target
    |> String.replace_prefix("/", "")
    |> then(fn
      "xl/" <> _ = p -> p
      p -> "xl/" <> p
    end)
  end

  defp shared_strings(map) do
    case Map.get(map, "xl/sharedStrings.xml") do
      nil ->
        []

      xml ->
        # 简化：每个 <si>...</si> 拼内部全部 <t> 文本
        ~r/<si\b[^>]*>[\s\S]*?<\/si>/
        |> Regex.scan(xml)
        |> Enum.map(fn [si] ->
          ~r/<t[^>]*>([^<]*)<\/t>/
          |> Regex.scan(si)
          |> Enum.map(fn [_, t] -> t end)
          |> Enum.join()
          |> unescape()
        end)
    end
  end

  ## render_pages

  defp do_render_pages(pkg, docs) do
    template_sheet = pkg.map[pkg.sheet_path]
    blocks = Enum.map(docs, &expand_sheet(template_sheet, pkg.shared, &1))

    {body_rows, merges, breaks, final_dim} = stitch_blocks(blocks)
    sheet_out = rebuild_sheet(template_sheet, body_rows, merges, breaks, final_dim)

    # 打印区域：按块复制并偏移（workbook definedNames）
    wb_out = shift_print_areas(pkg.wb, pkg.sheets, length(docs), blocks)

    map =
      pkg.map
      |> Map.put(pkg.sheet_path, sheet_out)
      |> Map.put("xl/workbook.xml", wb_out)

    pack(pkg.files, map)
  end

  defp stitch_blocks([only]) do
    %{rows: rows, merges: merges, max_row: max_row, max_col: max_col} = only
    dim = dimension_ref(max_col, max_row)
    {rows, merges, [], dim}
  end

  defp stitch_blocks(blocks) do
    {rows, merges, breaks, offset, max_col} =
      Enum.reduce(blocks, {[], [], [], 0, 1}, fn block, {rs, ms, brs, off, mc} ->
        shifted_rows = Enum.map(block.rows, &shift_row_xml(&1, off))
        shifted_merges = Enum.map(block.merges, &shift_ref(&1, off))
        new_off = off + block.max_row
        # 分页符在块末行（Excel brk id = 该行之后分页，用块最大行号）
        brk_id = new_off
        mc2 = max(mc, block.max_col)

        {rs ++ shifted_rows, ms ++ shifted_merges, brs ++ [brk_id], new_off, mc2}
      end)

    # 最后一块后不需要分页符
    breaks = Enum.drop(breaks, -1)
    dim = dimension_ref(max_col, offset)
    {rows, merges, breaks, dim}
  end

  ## render_sheets

  defp do_render_sheets(pkg, named_docs) do
    template_sheet = pkg.map[pkg.sheet_path]
    names = unique_sheet_names(Enum.map(named_docs, &elem(&1, 0)))

    expanded =
      named_docs
      |> Enum.zip(names)
      |> Enum.map(fn {{_raw_name, doc}, name} ->
        block = expand_sheet(template_sheet, pkg.shared, doc)

        sheet_xml =
          rebuild_sheet(
            template_sheet,
            block.rows,
            block.merges,
            [],
            dimension_ref(block.max_col, block.max_row)
          )

        {name, sheet_xml}
      end)

    # 新 sheet 路径
    {sheet_entries, rels_entries, file_pairs, overrides} =
      expanded
      |> Enum.with_index(1)
      |> Enum.reduce({[], [], [], []}, fn {{name, xml}, i}, {se, re, fp, ov} ->
        path = "xl/worksheets/sheet_synie_#{i}.xml"
        rid = "rIdSynie#{i}"

        se = se ++ [~s|<sheet name="#{xml_escape(name)}" sheetId="#{1000 + i}" r:id="#{rid}"/>|]

        re =
          re ++
            [
              ~s|<Relationship Id="#{rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet_synie_#{i}.xml"/>|
            ]

        fp = fp ++ [{path, xml}]

        ov =
          ov ++
            [
              ~s|<Override PartName="/#{path}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>|
            ]

        {se, re, fp, ov}
      end)

    # 替换 workbook sheets 为仅导出 sheet（不要模板其它 sheet，避免空白页）
    wb =
      pkg.wb
      |> replace_sheets_section(Enum.join(sheet_entries))
      |> strip_print_areas()

    rels_path = "xl/_rels/workbook.xml.rels"
    # 保留 styles / sharedStrings 等非 worksheet rel，去掉旧 worksheet rel，追加新的
    old_rels = pkg.map[rels_path]

    kept_rels =
      ~r/<Relationship\b[^>]*\/>/
      |> Regex.scan(old_rels)
      |> Enum.map(fn [tag] -> tag end)
      |> Enum.reject(fn tag ->
        String.contains?(tag, "/worksheet") or String.contains?(tag, "worksheets/")
      end)

    new_rels_xml =
      old_rels
      |> then(fn xml ->
        inner = Enum.join(kept_rels ++ rels_entries)

        Regex.replace(~r/<Relationships\b[^>]*>[\s\S]*<\/Relationships>/, xml, fn full ->
          open = Regex.run(~r/<Relationships\b[^>]*>/, full) |> hd()
          open <> inner <> "</Relationships>"
        end)
      end)

    # Content_Types：去掉旧 worksheet override，加新的
    ct_path = "[Content_Types].xml"
    ct = pkg.map[ct_path]

    ct2 =
      ct
      |> String.replace(
        ~r/<Override[^>]*worksheets\/[^"']*"[^>]*\/>/,
        ""
      )
      |> String.replace("</Types>", Enum.join(overrides) <> "</Types>")

    # 从原 files 去掉旧 worksheet parts，加入新的
    map =
      pkg.map
      |> Map.drop(worksheet_paths(pkg))
      |> Map.put("xl/workbook.xml", wb)
      |> Map.put(rels_path, new_rels_xml)
      |> Map.put(ct_path, ct2)
      |> Map.merge(Map.new(file_pairs))

    # files list for pack: use map keys
    files =
      Enum.map(map, fn {k, v} -> {String.to_charlist(k), v} end)

    pack_files(files)
  end

  defp worksheet_paths(pkg) do
    pkg.sheets
    |> Enum.map(fn s -> resolve_path(pkg.rels[s.rid]) end)
    |> Enum.filter(& &1)
  end

  defp replace_sheets_section(wb, sheets_inner) do
    Regex.replace(~r/<sheets\b[^>]*>[\s\S]*?<\/sheets>/, wb, "<sheets>#{sheets_inner}</sheets>")
  end

  defp strip_print_areas(wb) do
    wb
    |> String.replace(~r/<definedName[^>]*_xlnm\.Print_Area[^>]*>[\s\S]*?<\/definedName>/, "")
    |> String.replace(~r/<definedNames\s*\/>/, "")
    |> String.replace(~r/<definedNames>\s*<\/definedNames>/, "")
  end

  ## 单 sheet 展开

  defp expand_sheet(sheet_xml, shared, doc) do
    fields = stringify_map(Map.get(doc, :fields) || Map.get(doc, "fields") || %{})

    loops =
      (Map.get(doc, :loops) || Map.get(doc, "loops") || %{})
      |> Map.new(fn {k, v} -> {to_string(k), Enum.map(v || [], &stringify_map/1)} end)

    ctx = %{fields: fields, loop_names: Map.keys(loops)}

    rows =
      @row_re
      |> Regex.scan(sheet_xml)
      |> Enum.map(fn [row] -> row end)

    if rows == [] do
      raise RenderError, message: "sheet 中没有 row"
    end

    # 逐行标注循环区模板行；多循环区各占一段，顺序展开，delta 累计下移
    tagged =
      Enum.map(rows, fn row ->
        case loop_row_prefix(row, shared, ctx.loop_names) do
          nil -> {:static, row}
          name -> {:loop, name, row}
        end
      end)

    {out_rows_rev, _delta, loop_plan_rev} =
      Enum.reduce(tagged, {[], 0, []}, fn
        {:static, row}, {acc, delta, plan} ->
          filled = row |> shift_row_xml(delta) |> fill_row(shared, ctx, nil)
          {[filled | acc], delta, plan}

        {:loop, name, row}, {acc, delta, plan} ->
          items = Map.get(loops, name, [])
          template_r = row_number!(row)

          emitted =
            items
            |> Enum.with_index(1)
            |> Enum.map(fn {item, seq} ->
              item_fields = Map.put(item, "_seq", Integer.to_string(seq))

              row
              |> shift_row_xml(delta + seq - 1)
              |> fill_row(shared, ctx, {name, item_fields})
            end)

          {Enum.reverse(emitted) ++ acc, delta + length(items) - 1,
           [{template_r, length(items)} | plan]}
      end)

    out_rows = Enum.reverse(out_rows_rev)
    loop_plan = Enum.reverse(loop_plan_rev)

    merges =
      extract_merge_refs(sheet_xml)
      |> Enum.map(&shift_merge_for_loops(&1, loop_plan))
      |> Enum.reject(&is_nil/1)

    max_col = max_column(out_rows)
    max_row = out_rows |> Enum.map(&row_number!/1) |> Enum.max()

    %{rows: out_rows, merges: merges, max_col: max_col, max_row: max_row}
  end

  # 多循环区 merge 顺移：整段落在某循环模板行上的 merge 丢弃（约定不跨循环行）；
  # 其余按各端点行号下方的累计 delta 分别顺移（跨循环行的 merge 顺移结果未定义，见 moduledoc）
  defp shift_merge_for_loops(ref, loop_plan) do
    {r1, r2} = ref_row_range(ref)

    if Enum.any?(loop_plan, fn {t_r, _n} -> t_r == r1 and r1 == r2 end) do
      nil
    else
      shift_ref_rows(ref, &delta_before(loop_plan, &1))
    end
  end

  defp delta_before(loop_plan, row) do
    Enum.reduce(loop_plan, 0, fn {t_r, n}, acc ->
      if t_r < row, do: acc + n - 1, else: acc
    end)
  end

  # merge 两端点按各自下方的累计 delta 分别顺移
  defp shift_ref_rows(ref, fun) do
    Regex.replace(@ref_re, ref, fn _, dol1, col, dol2, row ->
      r = String.to_integer(row)
      dol1 <> col <> dol2 <> Integer.to_string(r + fun.(r))
    end)
  end

  # 返回行内第一个循环区占位符的首段（该行为该循环区的模板行）；无则 nil
  defp loop_row_prefix(row_xml, shared, loop_names) do
    @cell_re
    |> Regex.scan(row_xml)
    |> Enum.find_value(fn [cell] ->
      case cell_text(cell, shared) do
        nil ->
          nil

        text ->
          @placeholder
          |> Regex.scan(text)
          |> Enum.find_value(fn [_, name] ->
            case String.split(name, ".", parts: 2) do
              [prefix, _] -> if prefix in loop_names, do: prefix
              _ -> nil
            end
          end)
      end
    end)
  end

  defp fill_row(row_xml, shared, ctx, loop_ctx) do
    Regex.replace(@cell_re, row_xml, fn cell ->
      fill_cell(cell, shared, ctx, loop_ctx)
    end)
  end

  defp fill_cell(cell, shared, ctx, loop_ctx) do
    case cell_text(cell, shared) do
      nil ->
        cell

      text ->
        if Regex.match?(@placeholder, text) do
          replaced =
            Regex.replace(@placeholder, text, fn _, name ->
              case String.split(name, ".", parts: 2) do
                [single] ->
                  Map.get(ctx.fields, single, "")

                [prefix, rest] ->
                  cond do
                    # 本循环区模板行内的该区占位
                    match?({^prefix, _}, loop_ctx) ->
                      {_, loop_fields} = loop_ctx
                      Map.get(loop_fields, rest, "")

                    # 循环占位出现在其模板行之外 → 空
                    prefix in ctx.loop_names ->
                      ""

                    # 头字段路径（关系.字段）
                    true ->
                      Map.get(ctx.fields, name, "")
                  end
              end
            end)

          replace_cell_with_inline(cell, replaced)
        else
          cell
        end
    end
  end

  defp replace_cell_with_inline(cell, text) do
    # 保留 r= 与 s= 样式
    r = attr(cell, "r") || "A1"
    s = attr(cell, "s")
    s_attr = if s, do: ~s| s="#{s}"|, else: ""
    escaped = xml_escape(text)
    ~s|<c r="#{r}"#{s_attr} t="inlineStr"><is><t>#{escaped}</t></is></c>|
  end

  defp cell_text(cell, shared) do
    cond do
      String.contains?(cell, ~s|t="inlineStr"|) or String.contains?(cell, ~s|t='inlineStr'|) ->
        case Regex.run(~r/<t[^>]*>([^<]*)<\/t>/, cell) do
          [_, t] -> unescape(t)
          _ -> ""
        end

      String.contains?(cell, ~s|t="s"|) or String.contains?(cell, ~s|t='s'|) ->
        case Regex.run(~r/<v>([^<]*)<\/v>/, cell) do
          [_, idx_s] ->
            idx = String.to_integer(idx_s)
            Enum.at(shared, idx)

          _ ->
            nil
        end

      true ->
        # 普通文本/数字：若有 <v> 且无公式当数字；占位符不会出现在纯数字格
        case Regex.run(~r/<is><t[^>]*>([^<]*)<\/t><\/is>/, cell) do
          [_, t] -> unescape(t)
          _ -> nil
        end
    end
  end

  ## rebuild sheet XML

  defp rebuild_sheet(template_sheet, rows, merges, breaks, dim) do
    sheet_data = "<sheetData>#{Enum.join(rows)}</sheetData>"

    merge_xml =
      case merges do
        [] ->
          ""

        list ->
          inner = Enum.map_join(list, fn ref -> ~s|<mergeCell ref="#{ref}"/>| end)
          ~s|<mergeCells count="#{length(list)}">#{inner}</mergeCells>|
      end

    brks_xml =
      case breaks do
        [] ->
          ""

        ids ->
          inner =
            Enum.map_join(ids, fn id ->
              ~s|<brk id="#{id}" max="16383" man="1"/>|
            end)

          ~s|<rowBreaks count="#{length(ids)}" manualBreakCount="#{length(ids)}">#{inner}</rowBreaks>|
      end

    xml =
      template_sheet
      |> replace_or_insert_sheet_data(sheet_data)
      |> replace_dimension(dim)
      |> replace_merges(merge_xml)
      |> remove_old_row_breaks()
      |> insert_row_breaks(brks_xml)

    xml
  end

  defp replace_or_insert_sheet_data(sheet, sheet_data) do
    if Regex.match?(~r/<sheetData\b/, sheet) do
      Regex.replace(~r/<sheetData\b[^>]*>[\s\S]*?<\/sheetData>/, sheet, sheet_data)
    else
      raise RenderError, message: "sheet 缺少 sheetData"
    end
  end

  defp replace_dimension(sheet, dim) do
    if Regex.match?(~r/<dimension\b/, sheet) do
      Regex.replace(~r/<dimension\b[^>]*\/>/, sheet, ~s|<dimension ref="#{dim}"/>|)
    else
      String.replace(sheet, "<sheetData", ~s|<dimension ref="#{dim}"/><sheetData|, global: false)
    end
  end

  defp replace_merges(sheet, merge_xml) do
    sheet = Regex.replace(@merge_re, sheet, "")

    if merge_xml == "" do
      sheet
    else
      # 插在 sheetData 之后
      String.replace(sheet, "</sheetData>", "</sheetData>" <> merge_xml, global: false)
    end
  end

  defp remove_old_row_breaks(sheet), do: Regex.replace(@brks_re, sheet, "")

  defp insert_row_breaks(sheet, ""), do: sheet

  defp insert_row_breaks(sheet, brks_xml) do
    # CT_Worksheet 中 rowBreaks 在 pageSetup 一带；插在 </worksheet> 前对 LO/Excel 均合法
    if String.contains?(sheet, "</worksheet>") do
      String.replace(sheet, "</worksheet>", brks_xml <> "</worksheet>", global: false)
    else
      sheet <> brks_xml
    end
  end

  defp shift_print_areas(wb, _sheets, n_docs, _blocks) when n_docs <= 1, do: wb

  defp shift_print_areas(wb, _sheets, _n_docs, blocks) do
    # 仅处理 localSheetId=0 的 Print_Area：复制为多段 union 或只扩展行
    Regex.replace(
      ~r/<definedName([^>]*name="_xlnm\.Print_Area"[^>]*)>([\s\S]*?)<\/definedName>/,
      wb,
      fn full ->
        if String.contains?(full, ~s|localSheetId="0"|) or
             String.contains?(full, "localSheetId='0'") or
             not String.contains?(full, "localSheetId") do
          case Regex.run(
                 ~r/<definedName([^>]*)>([\s\S]*?)<\/definedName>/,
                 full
               ) do
            [_, attrs, body] ->
              body = String.trim(body)
              # body 形如 'Sheet1'!$A$1:$D$10
              case Regex.run(~r/^(.*!)(.*)$/, body) do
                [_, prefix, area] ->
                  offsets = block_offsets(blocks)

                  areas =
                    offsets
                    |> Enum.map(fn off -> prefix <> shift_ref(area, off) end)
                    |> Enum.join(",")

                  ~s|<definedName#{attrs}>#{areas}</definedName>|

                _ ->
                  full
              end

            _ ->
              full
          end
        else
          full
        end
      end
    )
  end

  defp block_offsets(blocks) do
    {offs, _} =
      Enum.map_reduce(blocks, 0, fn b, off ->
        {off, off + b.max_row}
      end)

    offs
  end

  ## row / ref helpers

  defp row_number!(row_xml) do
    case attr(row_xml, "r") do
      nil -> raise RenderError, message: "row 缺少 r 属性"
      s -> String.to_integer(s)
    end
  end

  defp shift_row_xml(row_xml, 0), do: row_xml

  defp shift_row_xml(row_xml, delta) do
    r0 = row_number!(row_xml)
    r1 = r0 + delta

    # 先改单元格 ref，再改 row 的 r（避免全局替换误伤）
    shifted_cells =
      Regex.replace(@cell_re, row_xml, fn cell ->
        case attr(cell, "r") do
          nil ->
            cell

          ref ->
            new_ref = shift_a1(ref, delta)
            String.replace(cell, ~s|r="#{ref}"|, ~s|r="#{new_ref}"|, global: false)
        end
      end)

    # 只替换 row 开标签上的 r="N"
    Regex.replace(~r/<row\b([^>]*)\br="#{r0}"/, shifted_cells, fn _, rest ->
      ~s|<row#{rest} r="#{r1}"|
    end)
  end

  defp shift_ref(ref, 0), do: ref

  defp shift_ref(ref, delta) do
    Regex.replace(@ref_re, ref, fn _, dol1, col, dol2, row ->
      dol1 <> col <> dol2 <> Integer.to_string(String.to_integer(row) + delta)
    end)
  end

  defp shift_a1(ref, delta) do
    case Regex.run(~r/^(\$?)([A-Za-z]+)(\$?)(\d+)$/, ref) do
      [_, d1, col, d2, row] ->
        d1 <> col <> d2 <> Integer.to_string(String.to_integer(row) + delta)

      _ ->
        ref
    end
  end

  defp ref_row_range(ref) do
    rows =
      Regex.scan(~r/(\d+)/, ref)
      |> Enum.map(fn [_, n] -> String.to_integer(n) end)

    {Enum.min(rows), Enum.max(rows)}
  end

  defp extract_merge_refs(sheet) do
    case Regex.run(@merge_re, sheet) do
      [block] ->
        ~r/ref="([^"]+)"/
        |> Regex.scan(block)
        |> Enum.map(fn [_, ref] -> ref end)

      _ ->
        []
    end
  end

  defp max_column(rows) do
    rows
    |> Enum.flat_map(fn row ->
      @cell_re
      |> Regex.scan(row)
      |> Enum.map(fn [cell] ->
        case attr(cell, "r") do
          nil -> 1
          ref -> col_index(ref)
        end
      end)
    end)
    |> Enum.max(fn -> 1 end)
  end

  defp col_index(ref) do
    case Regex.run(~r/^\$?([A-Za-z]+)/, ref) do
      [_, letters] ->
        letters
        |> String.upcase()
        |> String.to_charlist()
        |> Enum.reduce(0, fn c, acc -> acc * 26 + (c - ?A + 1) end)

      _ ->
        1
    end
  end

  defp dimension_ref(max_col, max_row) do
    "A1:#{col_letters(max_col - 1)}#{max(max_row, 1)}"
  end

  defp col_letters(n) when n >= 0 do
    do_col(n, "")
  end

  defp do_col(n, acc) when n < 26, do: <<?A + n>> <> acc
  defp do_col(n, acc), do: do_col(div(n, 26) - 1, <<?A + rem(n, 26)>> <> acc)

  ## sheet names

  defp unique_sheet_names(names) do
    {result, _} =
      Enum.map_reduce(names, %{}, fn name, seen ->
        base = sanitize_sheet_name(name)
        take_unique_sheet_name(base, seen, 0)
      end)

    result
  end

  defp sanitize_sheet_name(name) when is_binary(name) do
    name
    |> String.replace(~r/[:\\\/\?\*\[\]]/, " ")
    |> String.trim()
    |> case do
      "" -> "Sheet"
      s -> s
    end
    |> String.slice(0, 31)
  end

  defp sanitize_sheet_name(_), do: "Sheet"

  defp take_unique_sheet_name(base, seen, n) do
    candidate =
      if n == 0 do
        base
      else
        suffix = " #{n}"
        String.slice(base, 0, max(31 - String.length(suffix), 1)) <> suffix
      end

    if Map.has_key?(seen, candidate) do
      take_unique_sheet_name(base, seen, n + 1)
    else
      {candidate, Map.put(seen, candidate, true)}
    end
  end

  ## pack

  defp pack(original_files, map) do
    files =
      Enum.map(original_files, fn {name, _} ->
        key = to_string(name)
        {name, Map.get(map, key)}
      end)
      |> Enum.reject(fn {_, content} -> is_nil(content) end)

    # 若 map 有新 key
    known = MapSet.new(Enum.map(original_files, fn {n, _} -> to_string(n) end))

    extra =
      map
      |> Enum.reject(fn {k, _} -> MapSet.member?(known, k) end)
      |> Enum.map(fn {k, v} -> {String.to_charlist(k), v} end)

    pack_files(files ++ extra)
  end

  defp pack_files(files) do
    {:ok, {_name, binary}} = :zip.create(~c"out.xlsx", files, [:memory])
    {:ok, binary}
  end

  ## utils

  defp attr(tag, name) do
    case Regex.run(~r/#{Regex.escape(name)}="([^"]*)"/, tag) do
      [_, v] ->
        v

      _ ->
        case Regex.run(~r/#{Regex.escape(name)}='([^']*)'/, tag) do
          [_, v] -> v
          _ -> nil
        end
    end
  end

  defp stringify_map(map) when is_map(map) do
    Map.new(map, fn
      {k, nil} -> {to_string(k), ""}
      {k, v} -> {to_string(k), to_string(v)}
    end)
  end

  defp xml_escape(s) do
    s
    |> to_string()
    |> String.replace("&", "&amp;")
    |> String.replace("<", "&lt;")
    |> String.replace(">", "&gt;")
    |> String.replace("\"", "&quot;")
  end

  defp unescape(s) do
    s
    |> String.replace("&lt;", "<")
    |> String.replace("&gt;", ">")
    |> String.replace("&quot;", "\"")
    |> String.replace("&amp;", "&")
  end
end
