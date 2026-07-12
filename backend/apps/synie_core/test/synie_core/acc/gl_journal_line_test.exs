defmodule SynieCore.Acc.GlJournalLineTest do
  use ExUnit.Case, async: true

  import SynieCore.AuthzFixtures

  alias SynieCore.Acc.{GlJournal, GlJournalLine}
  alias SynieCore.Authz.Actor
  alias SynieCore.Base.{Account, Currency}
  alias SynieCore.Sales.Customer

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)

    company = company!()

    currency =
      Currency
      |> Ash.Changeset.for_create(:create, %{name: "人民币", iso_code: "CNY", symbol: "¥"})
      |> Ash.create!(authorize?: false)

    account =
      Account
      |> Ash.Changeset.for_create(:create, %{
        code: "1001",
        name: "库存现金",
        direction: :debit,
        company_id: company.id,
        currency_id: currency.id
      })
      |> Ash.create!(authorize?: false)

    journal =
      GlJournal
      |> Ash.Changeset.for_create(:create, %{
        company_id: company.id,
        voucher_no: "记-0001",
        date: ~D[2026-07-09],
        posting_date: ~D[2026-07-09]
      })
      |> Ash.create!(authorize?: false)

    %{company: company, currency: currency, account: account, journal: journal}
  end

  defp line!(attrs, opts) do
    GlJournalLine
    |> Ash.Changeset.for_create(:create, attrs, opts)
    |> Ash.create!()
  end

  defp actor(overrides) do
    struct!(
      %Actor{user_id: Ash.UUID.generate(), permissions: MapSet.new(["acc.gl_journal:*"])},
      overrides
    )
  end

  defp base_attrs(journal, account) do
    %{journal_id: journal.id, idx: 1, account_id: account.id, debit: Decimal.new("100")}
  end

  test "创建行:company 冗余自凭证,币种复制自科目", ctx do
    line = line!(base_attrs(ctx.journal, ctx.account), authorize?: false)

    assert line.company_id == ctx.company.id
    assert line.currency_id == ctx.currency.id
  end

  test "汇总/停用/跨公司科目被拒", ctx do
    group =
      Account
      |> Ash.Changeset.for_create(:create, %{
        code: "1002",
        name: "汇总",
        direction: :debit,
        is_group: true,
        company_id: ctx.company.id
      })
      |> Ash.create!(authorize?: false)

    assert_raise Ash.Error.Invalid, ~r/汇总科目/, fn ->
      line!(%{base_attrs(ctx.journal, group) | idx: 2}, authorize?: false)
    end
  end

  test "party 成对且必须存在", ctx do
    assert_raise Ash.Error.Invalid, ~r/同时填写/, fn ->
      line!(Map.put(base_attrs(ctx.journal, ctx.account), :party_type, :customer),
        authorize?: false
      )
    end

    assert_raise Ash.Error.Invalid, ~r/对手不存在/, fn ->
      base_attrs(ctx.journal, ctx.account)
      |> Map.merge(%{party_type: :customer, party_id: Ash.UUID.generate()})
      |> line!(authorize?: false)
    end

    customer =
      Customer
      |> Ash.Changeset.for_create(:create, %{code: "C001", name: "客户甲"})
      |> Ash.create!(authorize?: false)

    line =
      base_attrs(ctx.journal, ctx.account)
      |> Map.merge(%{party_type: :customer, party_id: customer.id})
      |> line!(authorize?: false)

    assert line.party_id == customer.id
  end

  test "非草稿凭证不可增删改行", ctx do
    audited =
      Ash.Seed.seed!(GlJournal, %{
        company_id: ctx.company.id,
        voucher_no: "记-0002",
        date: ~D[2026-07-09],
        posting_date: ~D[2026-07-09],
        status: :audited
      })

    assert_raise Ash.Error.Invalid, ~r/草稿/, fn ->
      line!(base_attrs(audited, ctx.account), authorize?: false)
    end

    line = line!(base_attrs(ctx.journal, ctx.account), authorize?: false)
    Ash.Seed.update!(ctx.journal, %{status: :audited})

    assert_raise Ash.Error.Invalid, ~r/草稿/, fn ->
      line
      |> Ash.Changeset.for_update(:update, %{debit: Decimal.new("1")})
      |> Ash.update!(authorize?: false)
    end

    assert_raise Ash.Error.Invalid, ~r/草稿/, fn -> Ash.destroy!(line, authorize?: false) end
  end

  test "before_action 复检关闭竞态:构建期见草稿、事务内凭证已非草稿则拒绝", ctx do
    line = line!(base_attrs(ctx.journal, ctx.account), authorize?: false)

    # 构建期(此时凭证仍是草稿)先拿到有效 changeset,模拟并发审核抢先一步
    changeset = line |> Ash.Changeset.for_update(:update, %{debit: Decimal.new("1")})

    # 模拟另一并发事务已把凭证改为非草稿并提交:直接改库,绕过动作校验
    Ash.Seed.update!(ctx.journal, %{status: :audited})

    assert_raise Ash.Error.Invalid, ~r/仅草稿凭证可编辑分录行/, fn ->
      Ash.update!(changeset, authorize?: false)
    end
  end

  test "无公司授权不能往该公司凭证加行(CompanyAccessible)", ctx do
    outsider = actor(company_ids: [])

    assert_raise Ash.Error.Invalid, fn ->
      line!(base_attrs(ctx.journal, ctx.account), actor: outsider)
    end
  end

  test "无公司数据权限不能改/删行(CompanyScope);有权限则可改", ctx do
    line = line!(base_attrs(ctx.journal, ctx.account), authorize?: false)
    outsider = actor(company_ids: [])
    insider = actor(company_ids: [ctx.company.id])

    assert_raise Ash.Error.Forbidden, fn ->
      line
      |> Ash.Changeset.for_update(:update, %{debit: Decimal.new("1")})
      |> Ash.update!(actor: outsider)
    end

    assert_raise Ash.Error.Forbidden, fn ->
      Ash.destroy!(line, actor: outsider)
    end

    updated =
      line
      |> Ash.Changeset.for_update(:update, %{debit: Decimal.new("1")})
      |> Ash.update!(actor: insider)

    assert Decimal.equal?(updated.debit, Decimal.new("1"))
  end
end
