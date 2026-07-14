defmodule SynieCore.Files.StorageEndpointTest do
  use ExUnit.Case, async: true

  import SynieCore.AuthzFixtures

  alias SynieCore.Authz
  alias SynieCore.Files.File, as: StoredFile
  alias SynieCore.Files.StorageEndpoint

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

  defp endpoint!(attrs, opts \\ []) do
    attrs =
      Map.merge(
        %{
          name: "ep#{System.unique_integer([:positive])}",
          label: "测试接入",
          kind: :local,
          root: "uploads"
        },
        attrs
      )

    changeset = Ash.Changeset.for_create(StorageEndpoint, :create, attrs)

    changeset =
      Enum.reduce(Keyword.take(opts, [:builtin, :is_default]), changeset, fn {k, v}, cs ->
        Ash.Changeset.force_change_attribute(cs, k, v)
      end)

    Ash.create!(changeset, authorize?: false)
  end

  describe "权限" do
    test "无权限用户不可建,授权 sys.storage:create 后可建" do
      denied = actor_with!([])

      assert {:error, %Ash.Error.Forbidden{}} =
               StorageEndpoint
               |> Ash.Changeset.for_create(:create, %{
                 name: "a1",
                 label: "本地",
                 kind: :local,
                 root: "up"
               })
               |> Ash.create(actor: denied)

      allowed = actor_with!(["sys.storage:create", "sys.storage:read"])

      assert %StorageEndpoint{name: "a1"} =
               StorageEndpoint
               |> Ash.Changeset.for_create(:create, %{
                 name: "a1",
                 label: "本地",
                 kind: :local,
                 root: "up"
               })
               |> Ash.create!(actor: allowed)
    end
  end

  describe "create/update 校验" do
    test "name 格式:大写/空格/中文/中划线开头拒绝" do
      for bad <- ["OSS", "a b", "存储", "-a"] do
        assert {:error, %Ash.Error.Invalid{}} =
                 StorageEndpoint
                 |> Ash.Changeset.for_create(:create, %{
                   name: bad,
                   label: "x",
                   kind: :local,
                   root: "up"
                 })
                 |> Ash.create(authorize?: false)
      end
    end

    test "name 重复报中文错" do
      endpoint!(%{name: "dup1"})

      assert {:error, err} =
               StorageEndpoint
               |> Ash.Changeset.for_create(:create, %{
                 name: "dup1",
                 label: "x",
                 kind: :local,
                 root: "up"
               })
               |> Ash.create(authorize?: false)

      assert Exception.message(err) =~ "接入名已存在"
    end

    test "kind 条件必填:local 缺 root、s3 缺 bucket/密钥 都拒绝" do
      assert {:error, _} =
               StorageEndpoint
               |> Ash.Changeset.for_create(:create, %{name: "l1", label: "x", kind: :local})
               |> Ash.create(authorize?: false)

      assert {:error, _} =
               StorageEndpoint
               |> Ash.Changeset.for_create(:create, %{
                 name: "s1",
                 label: "x",
                 kind: :s3,
                 endpoint: "http://e"
               })
               |> Ash.create(authorize?: false)

      assert %StorageEndpoint{} =
               StorageEndpoint
               |> Ash.Changeset.for_create(:create, %{
                 name: "s2",
                 label: "x",
                 kind: :s3,
                 endpoint: "http://minio:9000",
                 bucket: "b",
                 access_key_id: "ak",
                 secret_access_key: "sk"
               })
               |> Ash.create!(authorize?: false)
    end

    test "update 可改 label/root,不接受 name/kind" do
      ep = endpoint!(%{name: "imm1"})

      updated =
        ep
        |> Ash.Changeset.for_update(:update, %{label: "改名", root: "elsewhere"})
        |> Ash.update!(authorize?: false)

      assert updated.label == "改名"
      assert updated.root == "elsewhere"

      assert {:error, %Ash.Error.Invalid{}} =
               ep
               |> Ash.Changeset.for_update(:update, %{name: "renamed"})
               |> Ash.update(authorize?: false)

      assert {:error, %Ash.Error.Invalid{}} =
               ep
               |> Ash.Changeset.for_update(:update, %{kind: :s3})
               |> Ash.update(authorize?: false)
    end
  end

  describe "set_default" do
    test "切换默认:旧默认自动清掉,全表恒只有一行默认" do
      a = endpoint!(%{name: "d1"}, is_default: true)
      b = endpoint!(%{name: "d2"})

      actor = actor_with!(["sys.storage:update", "sys.storage:read"])

      b |> Ash.Changeset.for_update(:set_default, %{}) |> Ash.update!(actor: actor)

      assert Ash.get!(StorageEndpoint, a.id, authorize?: false).is_default == false
      assert Ash.get!(StorageEndpoint, b.id, authorize?: false).is_default == true
    end

    test "set_default 复用 update 权限码,无权拒绝" do
      ep = endpoint!(%{name: "d3"})
      denied = actor_with!(["sys.storage:read"])

      assert {:error, %Ash.Error.Forbidden{}} =
               ep |> Ash.Changeset.for_update(:set_default, %{}) |> Ash.update(actor: denied)
    end
  end

  describe "destroy 保护" do
    test "内置行不可删" do
      ep = endpoint!(%{name: "b1"}, builtin: true)
      assert {:error, err} = Ash.destroy(ep, authorize?: false)
      assert Exception.message(err) =~ "内置存储接入不可删除"
    end

    test "默认行不可删" do
      ep = endpoint!(%{name: "df1"}, is_default: true)
      assert {:error, err} = Ash.destroy(ep, authorize?: false)
      assert Exception.message(err) =~ "默认存储接入不可删除"
    end

    test "仍有文件引用不可删" do
      ep = endpoint!(%{name: "used1"})

      StoredFile
      |> Ash.Changeset.for_create(:create, %{storage: "used1", key: "k.bin", filename: "k.bin"})
      |> Ash.create!(authorize?: false)

      assert {:error, err} = Ash.destroy(ep, authorize?: false)
      assert Exception.message(err) =~ "仍有文件存于该接入点"
    end

    test "普通行可删" do
      ep = endpoint!(%{name: "free1"})
      assert :ok = Ash.destroy(ep, authorize?: false)
    end
  end
end
