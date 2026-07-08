defmodule SynieCore.Authz.CompanyScopeTest do
  use ExUnit.Case, async: true

  alias SynieCore.Authz.Actor
  alias SynieCore.Test.Doc

  @co_a Ash.UUID.generate()
  @co_b Ash.UUID.generate()

  defp seed_docs! do
    for {title, co} <- [{"A1", @co_a}, {"A2", @co_a}, {"B1", @co_b}] do
      Doc
      |> Ash.Changeset.for_create(:create, %{title: title, company_id: co})
      |> Ash.create!(authorize?: false)
    end
  end

  defp actor(overrides \\ %{}) do
    struct!(
      %Actor{user_id: Ash.UUID.generate(), permissions: MapSet.new(["test.doc:*"])},
      overrides
    )
  end

  test "读取仅返回授权公司的行" do
    seed_docs!()

    docs = Ash.read!(Doc, actor: actor(%{company_ids: [@co_a]}))

    assert Enum.map(docs, & &1.title) |> Enum.sort() == ["A1", "A2"]
  end

  test "fail-closed:无授权公司则看不到任何行" do
    seed_docs!()

    assert Ash.read!(Doc, actor: actor()) == []
  end

  test "all_companies 看到全部行" do
    seed_docs!()

    docs = Ash.read!(Doc, actor: actor(%{all_companies: true}))

    assert length(docs) == 3
  end

  test "super_admin 看到全部行" do
    seed_docs!()

    docs = Ash.read!(Doc, actor: actor(%{super_admin: true, permissions: MapSet.new()}))

    assert length(docs) == 3
  end

  test "写入:只能在授权公司下创建" do
    a_user = actor(%{company_ids: [@co_a]})

    assert {:ok, _} =
             Doc
             |> Ash.Changeset.for_create(:create, %{title: "ok", company_id: @co_a},
               actor: a_user
             )
             |> Ash.create()

    assert {:error, %Ash.Error.Invalid{}} =
             Doc
             |> Ash.Changeset.for_create(:create, %{title: "bad", company_id: @co_b},
               actor: a_user
             )
             |> Ash.create()
  end

  test "写入:all_companies 可在任意公司创建" do
    assert {:ok, _} =
             Doc
             |> Ash.Changeset.for_create(:create, %{title: "any", company_id: @co_b},
               actor: actor(%{all_companies: true})
             )
             |> Ash.create()
  end

  test "功能权限仍然生效:无 test.doc 权限即使公司匹配也被拒" do
    no_perm = actor(%{permissions: MapSet.new(), company_ids: [@co_a]})

    assert {:error, %Ash.Error.Forbidden{}} = Ash.read(Doc, actor: no_perm)
  end
end
