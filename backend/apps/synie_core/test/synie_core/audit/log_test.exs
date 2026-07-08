defmodule SynieCore.Audit.LogTest do
  use ExUnit.Case, async: true

  alias SynieCore.Audit.Log
  alias SynieCore.Authz.Actor

  @co_a Ash.UUID.generate()
  @co_b Ash.UUID.generate()

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)
  end

  defp log!(attrs) do
    Log
    |> Ash.Changeset.for_create(
      :record,
      Map.merge(
        %{
          resource: "bas_currency",
          record_id: Ash.UUID.generate(),
          action_type: "update",
          action_name: "update",
          changes: %{"name" => %{"from" => "a", "to" => "b"}}
        },
        attrs
      )
    )
    |> Ash.create!(authorize?: false)
  end

  defp reader(overrides \\ %{}) do
    struct!(
      %Actor{user_id: Ash.UUID.generate(), permissions: MapSet.new(["sys.audit_log:read"])},
      overrides
    )
  end

  test "资源声明了权限前缀" do
    assert Log.permission_prefix() == "sys.audit_log"
    assert Log.permission_actions() == ~w(read)
  end

  test "无权限码读取被拒绝" do
    assert {:error, %Ash.Error.Forbidden{}} =
             Ash.read(Log, actor: %Actor{user_id: Ash.UUID.generate()})
  end

  test "全局资源日志(company_id 为空)有权限码即可见" do
    log!(%{})

    assert [_] = Ash.read!(Log, actor: reader())
  end

  test "公司日志 fail-closed:空 company_id 行 + 授权公司行可见" do
    log!(%{})
    log!(%{company_id: @co_a})
    log!(%{company_id: @co_b})

    assert length(Ash.read!(Log, actor: reader(%{company_ids: [@co_a]}))) == 2
    assert [_] = Ash.read!(Log, actor: reader())
  end

  test "super_admin 全可见" do
    log!(%{})
    log!(%{company_id: @co_a})

    admin = reader(%{super_admin: true, permissions: MapSet.new()})

    assert length(Ash.read!(Log, actor: admin)) == 2
  end
end
