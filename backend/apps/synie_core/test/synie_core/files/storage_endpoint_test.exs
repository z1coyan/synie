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

  describe "密钥只写" do
    test "create 经 argument 写入 secret,内部读回可用(adapter 签名依赖)" do
      ep =
        StorageEndpoint
        |> Ash.Changeset.for_create(:create, %{
          name: "sec1",
          label: "x",
          kind: :s3,
          endpoint: "http://minio:9000",
          bucket: "b",
          access_key_id: "ak",
          secret_access_key: "sk-create"
        })
        |> Ash.create!(authorize?: false)

      assert Ash.get!(StorageEndpoint, ep.id, authorize?: false).secret_access_key == "sk-create"
    end

    test "update 不传/传空串 argument 保持旧值,传新值则更新" do
      ep =
        StorageEndpoint
        |> Ash.Changeset.for_create(:create, %{
          name: "sec2",
          label: "x",
          kind: :s3,
          endpoint: "http://minio:9000",
          bucket: "b",
          access_key_id: "ak",
          secret_access_key: "sk-old"
        })
        |> Ash.create!(authorize?: false)

      # 不传 argument:保持旧值(KindFields 回退已存值,不误报必填)
      ep
      |> Ash.Changeset.for_update(:update, %{label: "改名"})
      |> Ash.update!(authorize?: false)

      assert Ash.get!(StorageEndpoint, ep.id, authorize?: false).secret_access_key == "sk-old"

      # 传空串:保持旧值
      ep
      |> Ash.Changeset.for_update(:update, %{secret_access_key: ""})
      |> Ash.update!(authorize?: false)

      assert Ash.get!(StorageEndpoint, ep.id, authorize?: false).secret_access_key == "sk-old"

      # 传新值:更新
      ep
      |> Ash.Changeset.for_update(:update, %{secret_access_key: "sk-new"})
      |> Ash.update!(authorize?: false)

      assert Ash.get!(StorageEndpoint, ep.id, authorize?: false).secret_access_key == "sk-new"
    end

    test "s3 create 不传 secret argument 报 KindFields 必填" do
      assert {:error, err} =
               StorageEndpoint
               |> Ash.Changeset.for_create(:create, %{
                 name: "sec3",
                 label: "x",
                 kind: :s3,
                 endpoint: "http://e",
                 bucket: "b",
                 access_key_id: "ak"
               })
               |> Ash.create(authorize?: false)

      assert Exception.message(err) =~ "该存储类型下「Secret Access Key」必填"
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
