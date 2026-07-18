defmodule SynieCore.NumberingTest do
  use ExUnit.Case, async: true

  import SynieCore.AuthzFixtures

  alias SynieCore.Acc.GlJournal
  alias SynieCore.Numbering

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)
    %{company: company!()}
  end

  @default_segments [
    %{"type" => "text", "value" => "记"},
    %{"type" => "field", "field" => "company.code"},
    %{"type" => "text", "value" => "-"},
    %{"type" => "field", "field" => "date", "format" => "YYYYMM"},
    %{"type" => "text", "value" => "-"},
    %{"type" => "seq", "padding" => 4}
  ]

  defp rule!(attrs) do
    Numbering.Rule
    |> Ash.Changeset.for_create(
      :create,
      Map.merge(
        %{resource: "acc.gl_journal", name: "测试规则", segments: @default_segments},
        attrs
      ),
      authorize?: false
    )
    |> Ash.create!()
  end

  # 构建期形态的 changeset(不跑 create action,专测 next/1)
  defp journal_changeset(attrs) do
    GlJournal
    |> Ash.Changeset.new()
    |> Ash.Changeset.force_change_attributes(attrs)
  end

  describe "取号" do
    test "按段渲染并连号", %{company: co} do
      rule!(%{})
      cs = journal_changeset(%{company_id: co.id, date: ~D[2026-07-15]})

      assert {:ok, no1} = Numbering.next(cs)
      assert {:ok, no2} = Numbering.next(cs)

      assert no1 == "记#{co.code}-202607-0001"
      assert no2 == "记#{co.code}-202607-0002"
    end

    test "日期段渲染变了序号自然从头计(无独立重置周期)", %{company: co} do
      rule!(%{})

      assert {:ok, _} =
               Numbering.next(journal_changeset(%{company_id: co.id, date: ~D[2026-07-15]}))

      assert {:ok, no} =
               Numbering.next(journal_changeset(%{company_id: co.id, date: ~D[2026-08-01]}))

      assert no == "记#{co.code}-202608-0001"
    end

    test "按公司独立计数", %{company: co} do
      other = company!()
      rule!(%{})

      assert {:ok, no1} =
               Numbering.next(journal_changeset(%{company_id: co.id, date: ~D[2026-07-15]}))

      assert {:ok, no2} =
               Numbering.next(journal_changeset(%{company_id: other.id, date: ~D[2026-07-15]}))

      assert String.ends_with?(no1, "0001")
      assert String.ends_with?(no2, "0001")
    end

    test "不按公司计数时全局连号", %{company: co} do
      other = company!()

      rule!(%{
        per_company: false,
        segments: [
          %{"type" => "text", "value" => "GL-"},
          %{"type" => "field", "field" => "date", "format" => "YYYY"},
          %{"type" => "text", "value" => "-"},
          %{"type" => "seq", "padding" => 4}
        ]
      })

      assert {:ok, "GL-2026-0001"} =
               Numbering.next(journal_changeset(%{company_id: co.id, date: ~D[2026-07-15]}))

      assert {:ok, "GL-2026-0002"} =
               Numbering.next(journal_changeset(%{company_id: other.id, date: ~D[2026-07-15]}))
    end

    test "按公司计数但单据缺公司时报错" do
      rule!(%{
        segments: [%{"type" => "text", "value" => "A"}, %{"type" => "seq", "padding" => 4}]
      })

      assert {:error, msg} = Numbering.next(journal_changeset(%{date: ~D[2026-07-15]}))
      assert msg =~ "公司"
    end

    test "字段空值省略该段", %{company: co} do
      rule!(%{})

      # date 段空则省略,得到 记CODE--0001(两段固定分隔符之间无日期)
      assert {:ok, no} = Numbering.next(journal_changeset(%{company_id: co.id}))
      assert no == "记#{co.code}--0001"
    end

    test "padding 0 不补零", %{company: co} do
      rule!(%{
        per_company: false,
        segments: [
          %{"type" => "text", "value" => "N"},
          %{"type" => "seq", "padding" => 0}
        ]
      })

      assert {:ok, "N1"} =
               Numbering.next(journal_changeset(%{company_id: co.id, date: ~D[2026-07-15]}))

      assert {:ok, "N2"} =
               Numbering.next(journal_changeset(%{company_id: co.id, date: ~D[2026-07-15]}))
    end

    test "无规则或规则停用返回 no_rule", %{company: co} do
      cs = journal_changeset(%{company_id: co.id, date: ~D[2026-07-15]})
      assert {:error, :no_rule} = Numbering.next(cs)

      rule!(%{enabled: false})
      assert {:error, :no_rule} = Numbering.next(cs)
    end

    test "序号可在中间,位数可调", %{company: co} do
      rule!(%{
        segments: [
          %{"type" => "text", "value" => "A"},
          %{"type" => "seq", "padding" => 6},
          %{"type" => "text", "value" => "-"},
          %{"type" => "field", "field" => "date", "format" => "YYMMDD"}
        ]
      })

      assert {:ok, "A000001-260715"} =
               Numbering.next(journal_changeset(%{company_id: co.id, date: ~D[2026-07-15]}))
    end

    test "通用性:绑定另一资源(供应商)零改动即可取号,字段纯反射解析" do
      rule!(%{
        resource: "purchase.supplier",
        per_company: false,
        segments: [
          %{"type" => "text", "value" => "GYS-"},
          %{"type" => "field", "field" => "short_name"},
          %{"type" => "text", "value" => "-"},
          %{"type" => "seq", "padding" => 3}
        ]
      })

      cs =
        SynieCore.Purchase.Supplier
        |> Ash.Changeset.new()
        |> Ash.Changeset.force_change_attributes(%{short_name: "京泰"})

      assert {:ok, "GYS-京泰-001"} = Numbering.next(cs)
      assert {:ok, "GYS-京泰-002"} = Numbering.next(cs)
    end

    test "计数器可改当前值,后续取号顺延", %{company: co} do
      rule!(%{})
      cs = journal_changeset(%{company_id: co.id, date: ~D[2026-07-15]})
      {:ok, _} = Numbering.next(cs)

      [counter] = Ash.read!(Numbering.Counter, authorize?: false)
      assert counter.scope_key == "#{co.code}|记#{co.code}-202607-"

      counter
      |> Ash.Changeset.for_update(:update, %{value: 100}, authorize?: false)
      |> Ash.update!()

      assert {:ok, no} = Numbering.next(cs)
      assert no == "记#{co.code}-202607-0101"
    end
  end

  describe "规则校验" do
    test "必须恰好一个序号段" do
      assert_raise Ash.Error.Invalid, ~r/序号段/, fn ->
        rule!(%{segments: [%{"type" => "text", "value" => "A"}]})
      end

      assert_raise Ash.Error.Invalid, ~r/序号段/, fn ->
        rule!(%{
          segments: [%{"type" => "seq", "padding" => 4}, %{"type" => "seq", "padding" => 4}]
        })
      end
    end

    test "固定文本不能为空" do
      assert_raise Ash.Error.Invalid, ~r/固定文本/, fn ->
        rule!(%{
          segments: [%{"type" => "text", "value" => ""}, %{"type" => "seq", "padding" => 4}]
        })
      end
    end

    test "字段必须在绑定资源上存在" do
      assert_raise Ash.Error.Invalid, ~r/不存在/, fn ->
        rule!(%{
          segments: [%{"type" => "field", "field" => "nope"}, %{"type" => "seq", "padding" => 4}]
        })
      end

      assert_raise Ash.Error.Invalid, ~r/不存在/, fn ->
        rule!(%{
          segments: [
            %{"type" => "field", "field" => "company.nope"},
            %{"type" => "seq", "padding" => 4}
          ]
        })
      end
    end

    test "日期字段必须带合法格式,非日期字段不能带格式" do
      assert_raise Ash.Error.Invalid, ~r/格式/, fn ->
        rule!(%{
          segments: [%{"type" => "field", "field" => "date"}, %{"type" => "seq", "padding" => 4}]
        })
      end

      assert_raise Ash.Error.Invalid, ~r/格式/, fn ->
        rule!(%{
          segments: [
            %{"type" => "field", "field" => "remarks", "format" => "YYYY"},
            %{"type" => "seq", "padding" => 4}
          ]
        })
      end
    end

    test "绑定资源必须存在" do
      assert_raise Ash.Error.Invalid, ~r/绑定资源/, fn ->
        rule!(%{resource: "no.such_resource"})
      end
    end

    test "每资源至多一条启用规则,停用可共存" do
      rule!(%{})

      assert_raise Ash.Error.Invalid, ~r/只能启用一条/, fn -> rule!(%{name: "第二条"}) end

      disabled = rule!(%{name: "停用的", enabled: false})

      # 已有启用规则时,把停用规则改为启用同样被拒
      assert_raise Ash.Error.Invalid, ~r/只能启用一条/, fn ->
        disabled
        |> Ash.Changeset.for_update(:update, %{enabled: true}, authorize?: false)
        |> Ash.update!()
      end
    end
  end
end

# shared 沙箱模式是全局的,会劫持并行 async 测试的连接,故单独放 async: false 模块(串行跑)
defmodule SynieCore.NumberingConcurrencyTest do
  use ExUnit.Case, async: false

  import SynieCore.AuthzFixtures

  alias SynieCore.Acc.GlJournal
  alias SynieCore.Numbering

  test "并发取号不重号" do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)
    Ecto.Adapters.SQL.Sandbox.mode(SynieCore.Repo, {:shared, self()})

    co = company!()

    Numbering.Rule
    |> Ash.Changeset.for_create(
      :create,
      %{
        resource: "acc.gl_journal",
        name: "并发测试",
        segments: [
          %{"type" => "text", "value" => "J-"},
          %{"type" => "field", "field" => "date", "format" => "YYYYMM"},
          %{"type" => "text", "value" => "-"},
          %{"type" => "seq", "padding" => 4}
        ]
      },
      authorize?: false
    )
    |> Ash.create!()

    cs =
      GlJournal
      |> Ash.Changeset.new()
      |> Ash.Changeset.force_change_attributes(%{company_id: co.id, date: ~D[2026-07-15]})

    numbers =
      1..20
      |> Task.async_stream(
        fn _ ->
          {:ok, no} = Numbering.next(cs)
          no
        end,
        max_concurrency: 10
      )
      |> Enum.map(fn {:ok, no} -> no end)

    assert length(Enum.uniq(numbers)) == 20
    assert "J-202607-0020" in numbers
  end
end
