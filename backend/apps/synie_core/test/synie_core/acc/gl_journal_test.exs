defmodule SynieCore.Acc.GlJournalTest do
  use ExUnit.Case, async: true

  import SynieCore.AuthzFixtures

  alias SynieCore.Acc.GlJournal
  alias SynieCore.Authz.Actor

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)
    %{company: company!()}
  end

  defp actor(overrides) do
    struct!(
      %Actor{user_id: Ash.UUID.generate(), permissions: MapSet.new(["acc.gl_journal:*"])},
      overrides
    )
  end

  defp journal!(attrs, opts) do
    GlJournal
    |> Ash.Changeset.for_create(:create, attrs, opts)
    |> Ash.create!()
  end

  defp base_attrs(co) do
    %{
      company_id: co.id,
      voucher_no: "记-#{System.unique_integer([:positive])}",
      date: ~D[2026-07-09],
      posting_date: ~D[2026-07-09]
    }
  end

  test "创建默认草稿,编写人自动取 actor", %{company: co} do
    user = user!()
    actor = actor(user_id: user.id, company_ids: [co.id])
    journal = journal!(base_attrs(co), actor: actor)

    assert journal.status == :draft
    assert journal.created_by_id == user.id
    assert journal.submitted_by_id == nil
  end

  test "无公司授权不能创建(CompanyAccessible)", %{company: co} do
    assert_raise Ash.Error.Invalid, fn ->
      journal!(base_attrs(co), actor: actor([]))
    end
  end

  test "编号同公司唯一,跨公司可重复", %{company: co} do
    other = company!()
    attrs = %{base_attrs(co) | voucher_no: "记-0001"}

    journal!(attrs, authorize?: false)
    journal!(%{attrs | company_id: other.id}, authorize?: false)

    assert_raise Ash.Error.Invalid, fn -> journal!(attrs, authorize?: false) end
  end

  test "草稿可改;非草稿更新/删除被拒", %{company: co} do
    draft = journal!(base_attrs(co), authorize?: false)

    updated =
      draft
      |> Ash.Changeset.for_update(:update, %{remarks: "备注"})
      |> Ash.update!(authorize?: false)

    assert updated.remarks == "备注"

    audited = Ash.Seed.seed!(GlJournal, Map.put(base_attrs(co), :status, :audited))

    assert_raise Ash.Error.Invalid, fn ->
      audited
      |> Ash.Changeset.for_update(:update, %{remarks: "x"})
      |> Ash.update!(authorize?: false)
    end

    assert_raise Ash.Error.Invalid, fn -> Ash.destroy!(audited, authorize?: false) end
    assert :ok = Ash.destroy!(draft, authorize?: false)
  end

  describe "自动编号" do
    defp numbering_rule! do
      SynieCore.Numbering.Rule
      |> Ash.Changeset.for_create(
        :create,
        %{
          resource: "acc.gl_journal",
          name: "记账凭证",
          segments: [
            %{"type" => "text", "value" => "记"},
            %{"type" => "field", "field" => "company.code"},
            %{"type" => "text", "value" => "-"},
            %{"type" => "field", "field" => "date", "format" => "YYYYMM"},
            %{"type" => "text", "value" => "-"},
            %{"type" => "seq", "padding" => 4}
          ]
        },
        authorize?: false
      )
      |> Ash.create!()
    end

    test "编号留空按规则自动取号", %{company: co} do
      numbering_rule!()
      attrs = base_attrs(co) |> Map.delete(:voucher_no) |> Map.put(:date, ~D[2026-07-10])

      assert journal!(attrs, authorize?: false).voucher_no == "记#{co.code}-202607-0001"
      assert journal!(attrs, authorize?: false).voucher_no == "记#{co.code}-202607-0002"
    end

    test "手填编号原样保留", %{company: co} do
      numbering_rule!()
      journal = journal!(%{base_attrs(co) | voucher_no: "记-手填"}, authorize?: false)

      assert journal.voucher_no == "记-手填"
    end

    test "无规则且留空报错提示配置规则", %{company: co} do
      error =
        assert_raise Ash.Error.Invalid, fn ->
          journal!(Map.delete(base_attrs(co), :voucher_no), authorize?: false)
        end

      assert Exception.message(error) =~ "编号规则"
    end
  end

  test "无公司数据权限不能改凭证(CompanyScope)", %{company: co} do
    draft = journal!(base_attrs(co), authorize?: false)
    outsider = actor(company_ids: [])

    assert_raise Ash.Error.Forbidden, fn ->
      draft
      |> Ash.Changeset.for_update(:update, %{remarks: "备注"})
      |> Ash.update!(actor: outsider)
    end
  end
end
