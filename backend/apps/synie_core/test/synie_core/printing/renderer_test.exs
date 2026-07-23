defmodule SynieCore.Printing.RendererTest do
  use ExUnit.Case, async: true

  alias SynieCore.Printing.Renderer
  alias SynieCore.PrintingFixture

  defp doc(fields, items \\ []) do
    %{fields: fields, loops: %{"items" => items}}
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

    test "头字段路径占位符（关系.字段）替换" do
      template =
        PrintingFixture.build(rows: [["${company.name}", "${company.code}", "${order_no}"]])

      assert {:ok, out} =
               Renderer.render_pages(template, [
                 %{
                   fields: %{
                     "company.name" => "京泰电气",
                     "company.code" => "JT",
                     "order_no" => "SO-1"
                   },
                   loops: %{}
                 }
               ])

      assert [["京泰电气", "JT", "SO-1"]] = PrintingFixture.read_first_sheet(out)
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

    test "循环区按关系名寻址（非 items 名称同样展开）" do
      template =
        PrintingFixture.build(
          rows: [
            ["头 ${bom_name}"],
            ["${components._seq}", "${components.material_name}", "${components.qty}"],
            ["尾注"]
          ]
        )

      doc = %{
        fields: %{"bom_name" => "BOM-1"},
        loops: %{
          "components" => [
            %{"material_name" => "铜排", "qty" => "2"},
            %{"material_name" => "网板", "qty" => "1"}
          ]
        }
      }

      assert {:ok, out} = Renderer.render_pages(template, [doc])

      assert [["头 BOM-1"], ["1", "铜排", "2"], ["2", "网板", "1"], ["尾注"]] =
               PrintingFixture.read_first_sheet(out)
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

    test "模板仅一行且为明细模板行，0 条目时展开后无行也不报错" do
      template = PrintingFixture.build(rows: [["${items.name}"]])

      assert {:ok, _out} = Renderer.render_pages(template, [doc(%{}, [])])
    end
  end

  describe "render_pages/2 多循环区" do
    test "两个循环区各占一段，按各自数据展开、_seq 各自编号" do
      template =
        PrintingFixture.build(
          rows: [
            ["头 ${name}"],
            ["${components._seq}", "${components.material_name}"],
            ["中间 ${code}"],
            ["${routes._seq}", "${routes.operation_name}"],
            ["尾注"]
          ]
        )

      doc = %{
        fields: %{"name" => "BOM-1", "code" => "C1"},
        loops: %{
          "components" => [%{"material_name" => "铜排"}, %{"material_name" => "网板"}],
          "routes" => [
            %{"operation_name" => "冲网"},
            %{"operation_name" => "分切"},
            %{"operation_name" => "焊接"}
          ]
        }
      }

      assert {:ok, out} = Renderer.render_pages(template, [doc])

      assert [
               ["头 BOM-1"],
               ["1", "铜排"],
               ["2", "网板"],
               ["中间 C1"],
               ["1", "冲网"],
               ["2", "分切"],
               ["3", "焊接"],
               ["尾注"]
             ] = PrintingFixture.read_first_sheet(out)
    end

    test "某循环区 0 行仅删该区模板行，其余循环区不受影响" do
      template =
        PrintingFixture.build(
          rows: [
            ["${components.name}"],
            ["${byproducts.name}"],
            ["尾"]
          ]
        )

      doc = %{
        fields: %{},
        loops: %{"components" => [%{"name" => "甲"}], "byproducts" => []}
      }

      assert {:ok, out} = Renderer.render_pages(template, [doc])
      assert [["甲"], ["尾"]] = PrintingFixture.read_first_sheet(out)
    end

    test "多循环区下方 mergeCell 顺移" do
      template =
        PrintingFixture.build(
          rows: [
            ["${components.name}"],
            ["${routes.name}"],
            ["合并"]
          ],
          merges: ["A3:B3"]
        )

      doc = %{
        fields: %{},
        loops: %{
          "components" => [%{"name" => "a"}, %{"name" => "b"}],
          "routes" => [%{"name" => "r1"}]
        }
      }

      assert {:ok, out} = Renderer.render_pages(template, [doc])
      sheet = PrintingFixture.part(out, "xl/worksheets/sheet1.xml")
      # 行1→2行（+1）、行2→1行（+0）→ 原第3行变第4行
      assert sheet =~ ~s|ref="A4:B4"|
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

    test "模板含空白行（稀疏行号）时批量块不重叠" do
      template =
        PrintingFixture.build(
          rows: [
            {1, ["头:${a}"]},
            {3, ["尾:${b}"]}
          ]
        )

      docs = [
        doc(%{"a" => "1", "b" => "1"}),
        doc(%{"a" => "2", "b" => "2"})
      ]

      assert {:ok, out} = Renderer.render_pages(template, docs)

      sheet = PrintingFixture.part(out, "xl/worksheets/sheet1.xml")

      row_nos =
        ~r/<row\b[^>]*\br="(\d+)"/
        |> Regex.scan(sheet)
        |> Enum.map(fn [_, r] -> r end)

      # 第二块偏移 = 第一块最大行号（3），而非行元素个数（2）
      assert row_nos == ["1", "3", "4", "6"]
      assert length(row_nos) == length(Enum.uniq(row_nos))

      assert sheet =~ ~s|manualBreakCount="1"|
      assert sheet =~ ~s|<brk id="3"|
      assert sheet =~ ~s|<dimension ref="A1:A6"/>|
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

    test "稀疏模板（空白行）dimension 按最大行号计，非行元素个数" do
      template =
        PrintingFixture.build(
          rows: [
            {1, ["${a}"]},
            {3, ["${b}"]}
          ]
        )

      assert {:ok, out} =
               Renderer.render_sheets(template, [{"S1", doc(%{"a" => "1", "b" => "2"})}])

      sheet = PrintingFixture.part(out, "xl/worksheets/sheet_synie_1.xml")
      assert sheet =~ ~s|<dimension ref="A1:A3"/>|
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
    test "普通占位符进 fields，点号占位符按首段归组进 nested" do
      template =
        PrintingFixture.build(
          rows: [
            ["${order_no} ${company.name}"],
            ["${items.material_name}", "${items.qty}", "${order_no}"],
            [{:s, "${items.qty}"}]
          ]
        )

      assert {:ok, %{fields: fields, nested: nested}} = Renderer.extract_placeholders(template)
      assert fields == ["order_no"]
      assert nested == %{"company" => ["name"], "items" => ["material_name", "qty"]}
    end

    test "无点号占位符时 nested 为空" do
      template = PrintingFixture.build(rows: [["${a}"]])
      assert {:ok, %{fields: ["a"], nested: %{}}} = Renderer.extract_placeholders(template)
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
