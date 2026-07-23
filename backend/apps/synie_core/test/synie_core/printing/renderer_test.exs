defmodule SynieCore.Printing.RendererTest do
  use ExUnit.Case, async: true

  alias SynieCore.Printing.Renderer
  alias SynieCore.PrintingFixture

  defp doc(fields, items \\ []) do
    %{fields: fields, items: items}
  end

  describe "render_pages/2 单条（单头占位符）" do
    test "混排文本、空值、未知占位符替换为空" do
      template =
        PrintingFixture.build(
          rows: [
            ["订单号：${order_no}", "${company_name}", "${missing}"]
          ]
        )

      assert {:ok, out} =
               Renderer.render_pages(template, [
                 doc(%{"order_no" => "SO-1", "company_name" => ""})
               ])

      rows = PrintingFixture.read_first_sheet(out)
      assert [["订单号：SO-1", "", ""]] = rows
    end

    test "占位符藏在 sharedStrings 中也能替换（改写为 inline string）" do
      template =
        PrintingFixture.build(
          rows: [
            [{:s, "单号${order_no}"}, {:s, "固定"}]
          ]
        )

      assert {:ok, out} =
               Renderer.render_pages(template, [doc(%{"order_no" => "X9"})])

      rows = PrintingFixture.read_first_sheet(out)
      assert [["单号X9", "固定"]] = rows
    end

    test "渲染结果保留模板其余 part（styles 原样拷贝）" do
      template = PrintingFixture.build(rows: [["${a}"]])
      styles_before = PrintingFixture.part(template, "xl/styles.xml")

      assert {:ok, out} = Renderer.render_pages(template, [doc(%{"a" => "1"})])
      assert PrintingFixture.part(out, "xl/styles.xml") == styles_before
    end
  end

  describe "render_pages/2 明细行" do
    test "多条目：行复制、_seq、下方行与 mergeCell 顺移" do
      template =
        PrintingFixture.build(
          rows: [
            ["头 ${order_no}"],
            ["${items._seq}", "${items.material_name}", "${items.qty}"],
            ["尾注"]
          ],
          merges: ["A3:C3"]
        )

      assert {:ok, out} =
               Renderer.render_pages(template, [
                 doc(%{"order_no" => "O1"}, [
                   %{"material_name" => "甲", "qty" => "2"},
                   %{"material_name" => "乙", "qty" => "3"}
                 ])
               ])

      rows = PrintingFixture.read_first_sheet(out)
      assert [["头 O1"], ["1", "甲", "2"], ["2", "乙", "3"], ["尾注"]] = rows

      sheet = PrintingFixture.part(out, "xl/worksheets/sheet1.xml")
      assert sheet =~ ~s|ref="A4:C4"|
    end

    test "明细占位符藏在 sharedStrings 中也能识别明细模板行" do
      template =
        PrintingFixture.build(
          rows: [
            ["${order_no}"],
            [{:s, "${items.name}"}]
          ]
        )

      assert {:ok, out} =
               Renderer.render_pages(template, [
                 doc(%{"order_no" => "N"}, [%{"name" => "行A"}, %{"name" => "行B"}])
               ])

      assert [["N"], ["行A"], ["行B"]] = PrintingFixture.read_first_sheet(out)
    end

    test "0 条目：明细模板行整行删除，下方行上移" do
      template =
        PrintingFixture.build(
          rows: [
            ["头"],
            ["${items.name}"],
            ["尾"]
          ]
        )

      assert {:ok, out} =
               Renderer.render_pages(template, [doc(%{}, [])])

      assert [["头"], ["尾"]] = PrintingFixture.read_first_sheet(out)
    end

    test "无明细行的模板合法（items 为空也不报错）" do
      template = PrintingFixture.build(rows: [["仅头 ${title}"]])

      assert {:ok, out} =
               Renderer.render_pages(template, [doc(%{"title" => "T"}, [])])

      assert [["仅头 T"]] = PrintingFixture.read_first_sheet(out)
    end
  end

  describe "render_pages/2 批量（多块 + 分页符）" do
    test "两块顺序铺开，块间 rowBreak，mergeCell/打印区域按块复制" do
      template =
        PrintingFixture.build(
          rows: [
            ["${order_no}"],
            ["${items.name}"],
            ["底"]
          ],
          merges: ["A3:B3"],
          print_area: "$A$1:$B$3"
        )

      docs = [
        doc(%{"order_no" => "A"}, [%{"name" => "a1"}]),
        doc(%{"order_no" => "B"}, [%{"name" => "b1"}, %{"name" => "b2"}])
      ]

      assert {:ok, out} = Renderer.render_pages(template, docs)
      rows = PrintingFixture.read_first_sheet(out)
      # 块1: 头+1明细+底 = 3 行；块2: 头+2明细+底 = 4 行
      assert length(rows) == 7
      assert Enum.at(rows, 0) == ["A"]
      assert Enum.at(rows, 3) == ["B"]

      sheet = PrintingFixture.part(out, "xl/worksheets/sheet1.xml")
      assert sheet =~ "rowBreaks"
      assert sheet =~ ~s|id="3"|

      wb = PrintingFixture.part(out, "xl/workbook.xml")
      assert wb =~ "Print_Area"
    end

    test "三块且各块高度不同：偏移累计正确，分页符在各自块尾" do
      template =
        PrintingFixture.build(
          rows: [
            ["${n}"],
            ["${items.x}"]
          ]
        )

      docs = [
        doc(%{"n" => "1"}, [%{"x" => "a"}]),
        doc(%{"n" => "2"}, []),
        doc(%{"n" => "3"}, [%{"x" => "c1"}, %{"x" => "c2"}])
      ]

      assert {:ok, out} = Renderer.render_pages(template, docs)
      rows = PrintingFixture.read_first_sheet(out)
      # 块1: 2行；块2: 0条目删明细 → 1行；块3: 3行 → 共 6
      assert length(rows) == 6
      assert hd(rows) == ["1"]
      assert Enum.at(rows, 2) == ["2"]
      assert Enum.at(rows, 3) == ["3"]

      sheet = PrintingFixture.part(out, "xl/worksheets/sheet1.xml")
      assert sheet =~ ~s|id="2"|
      assert sheet =~ ~s|id="3"|
    end

    test "单 doc 不产生额外分页符；docs 为空报错" do
      template = PrintingFixture.build(rows: [["${a}"]])
      assert {:ok, out} = Renderer.render_pages(template, [doc(%{"a" => "1"})])
      refute PrintingFixture.part(out, "xl/worksheets/sheet1.xml") =~ "rowBreaks"

      assert {:error, :empty_docs} = Renderer.render_pages(template, [])
    end
  end

  describe "render_sheets/2" do
    test "每份 doc 一个 sheet，可分别读回" do
      template = PrintingFixture.build(rows: [["${no}"], ["${items.n}"]])

      assert {:ok, out} =
               Renderer.render_sheets(template, [
                 {"SO-1", doc(%{"no" => "1"}, [%{"n" => "x"}])},
                 {"SO-2", doc(%{"no" => "2"}, [%{"n" => "y"}])}
               ])

      sheets = PrintingFixture.read_all_sheets(out)
      names = Enum.map(sheets, &elem(&1, 0))
      assert "SO-1" in names
      assert "SO-2" in names

      by_name = Map.new(sheets)
      assert by_name["SO-1"] == [["1"], ["x"]]
      assert by_name["SO-2"] == [["2"], ["y"]]
    end

    test "sheet 名非法字符替换、31 字符截断、去重" do
      template = PrintingFixture.build(rows: [["${a}"]])
      long = String.duplicate("甲", 40)

      assert {:ok, out} =
               Renderer.render_sheets(template, [
                 {"甲/乙:丙", doc(%{"a" => "1"})},
                 {long, doc(%{"a" => "2"})},
                 {"dup", doc(%{"a" => "3"})},
                 {"dup", doc(%{"a" => "4"})}
               ])

      names = out |> PrintingFixture.read_all_sheets() |> Enum.map(&elem(&1, 0))
      assert Enum.any?(names, &String.contains?(&1, " "))
      assert Enum.all?(names, &(String.length(&1) <= 31))
      assert length(names) == length(Enum.uniq(names))
    end
  end

  describe "其余 sheet 原样保留" do
    test "render_pages 只填第一个 sheet" do
      template =
        PrintingFixture.build(
          sheets: [
            %{name: "主", rows: [["${a}"]]},
            %{name: "附", rows: [["不动"]]}
          ]
        )

      assert {:ok, out} = Renderer.render_pages(template, [doc(%{"a" => "V"})])
      sheets = Map.new(PrintingFixture.read_all_sheets(out))
      assert sheets["主"] == [["V"]]
      assert sheets["附"] == [["不动"]]
    end
  end

  describe "extract_placeholders/1" do
    test "提取 fields 与 items（去重排序，items 去前缀）" do
      template =
        PrintingFixture.build(
          rows: [
            ["${order_no} ${company_name}"],
            ["${items.material_name}", "${items.qty}", "${order_no}"],
            [{:s, "${items.qty}"}]
          ]
        )

      assert {:ok, %{fields: fields, items: items}} = Renderer.extract_placeholders(template)
      assert fields == ["company_name", "order_no"]
      assert items == ["material_name", "qty"]
    end

    test "无明细占位符时 items 为空" do
      template = PrintingFixture.build(rows: [["${a}"]])
      assert {:ok, %{fields: ["a"], items: []}} = Renderer.extract_placeholders(template)
    end
  end

  describe "错误处理" do
    test "非 xlsx 二进制返回 error" do
      assert {:error, {:invalid_template, _}} = Renderer.render_pages("not-zip", [doc(%{})])
      assert {:error, {:invalid_template, _}} = Renderer.extract_placeholders(<<0, 1, 2>>)
    end

    test "render_sheets 空列表报错" do
      template = PrintingFixture.build(rows: [["x"]])
      assert {:error, :empty_docs} = Renderer.render_sheets(template, [])
    end
  end
end
