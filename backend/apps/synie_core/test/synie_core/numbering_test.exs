defmodule SynieCore.NumberingTest do
  use ExUnit.Case, async: true

  import SynieCore.AuthzFixtures

  alias SynieCore.Numbering

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)
    %{company: company!()}
  end

  defp rule!(attrs) do
    Numbering.Rule
    |> Ash.Changeset.for_create(
      :create,
      Map.merge(
        %{
          code: "test.doc.#{System.unique_integer([:positive])}",
          name: "测试单据",
          format: "J{company}-{YYYY}{MM}-{seq}"
        },
        attrs
      ),
      authorize?: false
    )
    |> Ash.create!()
  end

  test "取号按格式模板渲染并连号", %{company: co} do
    rule = rule!(%{})

    assert {:ok, no1} = Numbering.next(rule.code, company_id: co.id, date: ~D[2026-07-15])
    assert {:ok, no2} = Numbering.next(rule.code, company_id: co.id, date: ~D[2026-07-15])

    assert no1 == "J#{co.code}-202607-0001"
    assert no2 == "J#{co.code}-202607-0002"
  end

  test "按月重置:跨月序号从头计", %{company: co} do
    rule = rule!(%{reset_period: :monthly})

    assert {:ok, "J" <> _} = Numbering.next(rule.code, company_id: co.id, date: ~D[2026-07-15])

    assert {:ok, no} = Numbering.next(rule.code, company_id: co.id, date: ~D[2026-08-01])
    assert no == "J#{co.code}-202608-0001"
  end

  test "按公司独立计数", %{company: co} do
    other = company!()
    rule = rule!(%{})

    assert {:ok, no1} = Numbering.next(rule.code, company_id: co.id, date: ~D[2026-07-15])
    assert {:ok, no2} = Numbering.next(rule.code, company_id: other.id, date: ~D[2026-07-15])

    assert String.ends_with?(no1, "0001")
    assert String.ends_with?(no2, "0001")
  end

  test "不按公司计数时全局连号", %{company: co} do
    other = company!()
    rule = rule!(%{format: "GL-{YYYY}-{seq}", per_company: false, reset_period: :yearly})

    assert {:ok, "GL-2026-0001"} = Numbering.next(rule.code, company_id: co.id, date: ~D[2026-07-15])
    assert {:ok, "GL-2026-0002"} = Numbering.next(rule.code, company_id: other.id, date: ~D[2026-07-15])
  end

  test "规则需要公司但未传时报错" do
    rule = rule!(%{})

    assert {:error, msg} = Numbering.next(rule.code, date: ~D[2026-07-15])
    assert msg =~ "公司"
  end

  test "无规则或规则停用返回 no_rule", %{company: co} do
    assert {:error, :no_rule} = Numbering.next("不存在的规则", company_id: co.id)

    rule = rule!(%{enabled: false})
    assert {:error, :no_rule} = Numbering.next(rule.code, company_id: co.id)
  end

  test "序号位数与自定义 token 组合", %{company: co} do
    rule = rule!(%{format: "A{YY}{MM}{DD}#{"{seq}"}", seq_padding: 6, reset_period: :daily})

    assert {:ok, "A260715000001"} = Numbering.next(rule.code, company_id: co.id, date: ~D[2026-07-15])
  end

  test "格式模板必须含 {seq}" do
    assert_raise Ash.Error.Invalid, fn -> rule!(%{format: "J-{YYYY}"}) end
  end

  test "计数器可改当前值,后续取号顺延", %{company: co} do
    rule = rule!(%{})
    {:ok, _} = Numbering.next(rule.code, company_id: co.id, date: ~D[2026-07-15])

    [counter] = Ash.read!(Numbering.Counter, authorize?: false)

    counter
    |> Ash.Changeset.for_update(:update, %{value: 100}, authorize?: false)
    |> Ash.update!()

    assert {:ok, no} = Numbering.next(rule.code, company_id: co.id, date: ~D[2026-07-15])
    assert no == "J#{co.code}-202607-0101"
  end
end

# shared 沙箱模式是全局的,会劫持并行 async 测试的连接,故单独放 async: false 模块(串行跑)
defmodule SynieCore.NumberingConcurrencyTest do
  use ExUnit.Case, async: false

  import SynieCore.AuthzFixtures

  alias SynieCore.Numbering

  test "并发取号不重号" do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)
    Ecto.Adapters.SQL.Sandbox.mode(SynieCore.Repo, {:shared, self()})

    co = company!()

    rule =
      Numbering.Rule
      |> Ash.Changeset.for_create(
        :create,
        %{code: "test.concurrent", name: "并发测试", format: "J{company}-{YYYY}{MM}-{seq}"},
        authorize?: false
      )
      |> Ash.create!()

    numbers =
      1..20
      |> Task.async_stream(
        fn _ -> Numbering.next!(rule.code, company_id: co.id, date: ~D[2026-07-15]) end,
        max_concurrency: 10
      )
      |> Enum.map(fn {:ok, no} -> no end)

    assert length(Enum.uniq(numbers)) == 20
    assert "J#{co.code}-202607-0020" in numbers
  end
end
