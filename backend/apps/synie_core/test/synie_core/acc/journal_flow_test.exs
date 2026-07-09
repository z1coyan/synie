defmodule SynieCore.Acc.JournalFlowTest do
  use ExUnit.Case, async: true

  import SynieCore.AuthzFixtures

  require Ash.Query

  alias SynieCore.Acc.{GlEntry, GlJournal, GlJournalLine}
  alias SynieCore.Authz.Actor
  alias SynieCore.Base.Account

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)

    company = company!()
    cash = account!(%{code: "1001", name: "库存现金", direction: :debit, company_id: company.id})
    sales = account!(%{code: "6001", name: "主营业务收入", direction: :credit, company_id: company.id})

    journal =
      GlJournal
      |> Ash.Changeset.for_create(:create, %{
        company_id: company.id,
        voucher_no: "记-0001",
        date: ~D[2026-07-09],
        posting_date: ~D[2026-07-10]
      })
      |> Ash.create!(authorize?: false)

    %{company: company, cash: cash, sales: sales, journal: journal}
  end

  defp account!(attrs) do
    Account
    |> Ash.Changeset.for_create(:create, attrs)
    |> Ash.create!(authorize?: false)
  end

  defp line!(journal, idx, account, side, amount) do
    attrs =
      Map.put(
        %{journal_id: journal.id, idx: idx, account_id: account.id},
        side,
        Decimal.new(amount)
      )

    GlJournalLine
    |> Ash.Changeset.for_create(:create, attrs)
    |> Ash.create!(authorize?: false)
  end

  defp audit!(journal, opts) do
    journal
    |> Ash.Changeset.for_update(:audit, %{}, opts)
    |> Ash.update!()
  end

  defp entries(journal) do
    GlEntry
    |> Ash.Query.filter(voucher_id == ^journal.id)
    |> Ash.read!(authorize?: false)
  end

  test "审核:生成配平分录,状态/提交人/提交时间落位", ctx do
    line!(ctx.journal, 1, ctx.cash, :debit, "100")
    line!(ctx.journal, 2, ctx.sales, :credit, "100")

    user = user!()

    actor =
      struct!(%Actor{user_id: user.id, permissions: MapSet.new(["acc.gl_journal:*"])},
        company_ids: [ctx.company.id]
      )

    audited = audit!(ctx.journal, actor: actor)

    assert audited.status == :audited
    assert audited.submitted_by_id == user.id
    assert audited.submitted_at != nil

    posted = entries(ctx.journal)
    assert length(posted) == 2
    assert Enum.all?(posted, &(&1.voucher_type == "acc.gl_journal" and &1.voucher_no == "记-0001"))
    assert Enum.all?(posted, &(&1.posting_date == ~D[2026-07-10]))
  end

  test "借贷不平/行数不足审核被拒,凭证保持草稿", ctx do
    line!(ctx.journal, 1, ctx.cash, :debit, "100")

    assert_raise Ash.Error.Invalid, ~r/分录不少于两行/, fn -> audit!(ctx.journal, authorize?: false) end

    line!(ctx.journal, 2, ctx.sales, :credit, "99")

    assert_raise Ash.Error.Invalid, ~r/借贷不平/, fn -> audit!(ctx.journal, authorize?: false) end

    assert Ash.get!(GlJournal, ctx.journal.id, authorize?: false).status == :draft
    assert entries(ctx.journal) == []
  end

  test "重复审核被拒;审核后头行冻结", ctx do
    line!(ctx.journal, 1, ctx.cash, :debit, "1")
    line!(ctx.journal, 2, ctx.sales, :credit, "1")
    audited = audit!(ctx.journal, authorize?: false)

    assert_raise Ash.Error.Invalid, ~r/仅草稿凭证可审核/, fn -> audit!(audited, authorize?: false) end

    assert_raise Ash.Error.Invalid, fn ->
      audited
      |> Ash.Changeset.for_update(:update, %{remarks: "x"})
      |> Ash.update!(authorize?: false)
    end
  end

  test "before_action 复检关闭双审核竞态:构建期见草稿、事务内已非草稿则拒绝", ctx do
    line!(ctx.journal, 1, ctx.cash, :debit, "1")
    line!(ctx.journal, 2, ctx.sales, :credit, "1")

    # 构建期(此时凭证仍是草稿)先拿到有效 changeset,模拟并发审核的第二个请求
    changeset = ctx.journal |> Ash.Changeset.for_update(:audit, %{}, authorize?: false)

    # 模拟另一并发事务已先行审核并提交:直接改库,绕过动作校验
    Ash.Seed.update!(ctx.journal, %{status: :audited})

    assert_raise Ash.Error.Invalid, ~r/仅草稿凭证可审核/, fn -> Ash.update!(changeset) end

    # 被拒的第二次审核未过账(before_action 复检在事务内拦住,after_action 未执行)
    assert entries(ctx.journal) == []
  end

  test "取消:分录标记作废,凭证终态;草稿不可取消", ctx do
    line!(ctx.journal, 1, ctx.cash, :debit, "8")
    line!(ctx.journal, 2, ctx.sales, :credit, "8")
    audited = audit!(ctx.journal, authorize?: false)

    cancelled =
      audited
      |> Ash.Changeset.for_update(:cancel, %{})
      |> Ash.update!(authorize?: false)

    assert cancelled.status == :cancelled
    assert Enum.all?(entries(ctx.journal), & &1.is_cancelled)

    assert_raise Ash.Error.Invalid, ~r/仅已审核凭证可取消/, fn ->
      cancelled
      |> Ash.Changeset.for_update(:cancel, %{})
      |> Ash.update!(authorize?: false)
    end

    draft =
      GlJournal
      |> Ash.Changeset.for_create(:create, %{
        company_id: ctx.company.id,
        voucher_no: "记-0002",
        date: ~D[2026-07-09],
        posting_date: ~D[2026-07-09]
      })
      |> Ash.create!(authorize?: false)

    assert_raise Ash.Error.Invalid, ~r/仅已审核凭证可取消/, fn ->
      draft
      |> Ash.Changeset.for_update(:cancel, %{})
      |> Ash.update!(authorize?: false)
    end
  end
end
