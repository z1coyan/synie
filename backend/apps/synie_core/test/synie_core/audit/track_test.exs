defmodule SynieCore.Audit.TrackTest do
  use ExUnit.Case, async: true

  import SynieCore.AuthzFixtures

  alias SynieCore.Audit.Log
  alias SynieCore.Authz.Actor
  alias SynieCore.Base.Currency

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)
  end

  defp actor do
    %Actor{user_id: Ash.UUID.generate(), username: "auditor", permissions: MapSet.new()}
  end

  defp currency!(attrs, opts \\ []) do
    Currency
    |> Ash.Changeset.for_create(
      :create,
      Map.merge(%{name: "美元", iso_code: "USD", symbol: "$"}, attrs)
    )
    |> Ash.create!(Keyword.merge([authorize?: false], opts))
  end

  defp logs_for(record_id) do
    Log
    |> Ash.Query.filter_input(%{record_id: record_id})
    |> Ash.read!(authorize?: false)
  end

  test "create 落审计日志(含操作人与展示名)" do
    a = actor()
    currency = currency!(%{}, actor: a)

    assert [log] = logs_for(currency.id)
    assert log.resource == "bas_currency"
    assert log.action_type == "create"
    assert log.action_name == "create"
    assert log.record_label == "美元"
    assert log.actor_id == a.user_id
    assert log.actor_name == "auditor"
    assert log.changes["iso_code"] == %{"to" => "USD"}
    refute Map.has_key?(log.changes, "id")
    refute Map.has_key?(log.changes, "inserted_at")
  end

  test "无 actor 的内部写入 actor 字段为空" do
    currency = currency!(%{})

    assert [log] = logs_for(currency.id)
    assert log.actor_id == nil
    assert log.actor_name == nil
  end

  test "update 只记录变更字段的 from/to" do
    currency = currency!(%{})

    currency
    |> Ash.Changeset.for_update(:update, %{name: "美刀"})
    |> Ash.update!(authorize?: false)

    assert [log] = Enum.filter(logs_for(currency.id), &(&1.action_type == "update"))
    assert log.changes == %{"name" => %{"from" => "美元", "to" => "美刀"}}
  end

  test "无实际变更的 update 不落日志" do
    currency = currency!(%{})

    currency
    |> Ash.Changeset.for_update(:update, %{name: "美元"})
    |> Ash.update!(authorize?: false)

    assert Enum.filter(logs_for(currency.id), &(&1.action_type == "update")) == []
  end

  test "destroy 记录删除前快照" do
    currency = currency!(%{})

    currency
    |> Ash.Changeset.for_destroy(:destroy)
    |> Ash.destroy!(authorize?: false)

    assert [log] = Enum.filter(logs_for(currency.id), &(&1.action_type == "destroy"))
    assert log.changes["name"] == %{"from" => "美元"}
    assert log.changes["iso_code"] == %{"from" => "USD"}
    assert log.record_label == "美元"
  end

  test "业务动作失败时不留审计日志" do
    assert_raise Ash.Error.Invalid, fn -> currency!(%{iso_code: "usd"}) end

    assert Ash.read!(Log, authorize?: false) == []
  end

  test "sensitive 属性记录为 [FILTERED]" do
    user = user!()

    assert [log] = logs_for(user.id)
    assert log.resource == "sys_user"
    assert log.action_name == "register"
    assert log.changes["hashed_password"] == %{"to" => "[FILTERED]"}
  end

  test "带 company_id 的资源日志冗余公司标识" do
    user = user!()
    company = company!()
    uc = grant_company!(user, company)

    assert [log] = logs_for(uc.id)
    assert log.resource == "sys_user_company"
    assert log.company_id == company.id
  end

  test "非 public 属性变更(set_super_admin)可审计" do
    user = user!()

    user
    |> Ash.Changeset.for_update(:set_super_admin, %{})
    |> Ash.update!(authorize?: false)

    assert [log] = Enum.filter(logs_for(user.id), &(&1.action_type == "update"))
    assert log.changes["super_admin"] == %{"from" => false, "to" => true}
  end
end
