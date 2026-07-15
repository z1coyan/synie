defmodule SynieCore.Acc.SettingTest do
  use ExUnit.Case, async: true

  import SynieCore.AuthzFixtures

  alias SynieCore.Acc.Setting
  alias SynieCore.Authz

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)
    :ok
  end

  defp actor_with!(permissions) do
    user = user!()
    role = role!()
    Enum.each(permissions, &grant!(role, &1))
    assign!(user, role)
    Authz.build_actor(user)
  end

  test "迁移 seed 保证单行存在,get/0 可取" do
    assert %Setting{} = Setting.get()
  end

  test "有 acc.setting:update 权限可更新凭证" do
    actor = actor_with!(["acc.setting:update", "acc.setting:read"])

    setting =
      Setting.get()
      |> Ash.Changeset.for_update(:update, %{ocr_access_key_id: "ak", ocr_access_key_secret: "sk"})
      |> Ash.update!(actor: actor)

    assert setting.ocr_access_key_id == "ak"
  end

  test "无权限者读写皆被拒绝" do
    actor = actor_with!([])

    # HasPermission 是 SimpleCheck(非 filter 型),base 权限缺失时策略无法降级为
    # 过滤空结果,与 audit_log/company_scope 的既有约定一致,直接 Forbidden
    assert {:error, %Ash.Error.Forbidden{}} = Ash.read(Setting, actor: actor)

    assert_raise Ash.Error.Forbidden, fn ->
      Setting.get()
      |> Ash.Changeset.for_update(:update, %{ocr_access_key_id: "x"})
      |> Ash.update!(actor: actor)
    end
  end

  test "ocr_configured:登录即可查,双凭证齐才为 true" do
    actor = actor_with!([])

    configured? = fn ->
      Setting
      |> Ash.ActionInput.for_action(:ocr_configured, %{})
      |> Ash.run_action!(actor: actor)
    end

    refute configured?.()

    Setting.get()
    |> Ash.Changeset.for_update(:update, %{ocr_access_key_id: "ak", ocr_access_key_secret: "sk"})
    |> Ash.update!(authorize?: false)

    assert configured?.()
  end
end
