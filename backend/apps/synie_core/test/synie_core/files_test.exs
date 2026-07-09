defmodule SynieCore.FilesTest do
  # 改全局 storage 配置,不能 async
  use ExUnit.Case, async: false

  import SynieCore.AuthzFixtures

  alias SynieCore.Authz
  alias SynieCore.Files
  alias SynieCore.Files.Attachment
  alias SynieCore.Storage

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)

    base = Path.join(System.tmp_dir!(), "synie_files_test_#{System.unique_integer([:positive])}")
    root = Path.join(base, "objects")
    File.mkdir_p!(root)

    src = Path.join(base, "合同.pdf")
    File.write!(src, "PDF 内容")

    old_storages = Application.fetch_env(:synie_core, :storages)
    old_default = Application.fetch_env(:synie_core, :default_storage)

    Application.put_env(:synie_core, :storages,
      test_local: %{adapter: SynieCore.Storage.Local, root: root}
    )

    Application.put_env(:synie_core, :default_storage, :test_local)

    on_exit(fn ->
      File.rm_rf!(base)
      restore = fn key, old ->
        case old do
          {:ok, v} -> Application.put_env(:synie_core, key, v)
          :error -> Application.delete_env(:synie_core, key)
        end
      end

      restore.(:storages, old_storages)
      restore.(:default_storage, old_default)
    end)

    %{root: root, src: src}
  end

  defp actor_with!(permissions) do
    user = user!()
    role = role!()
    Enum.each(permissions, &grant!(role, &1))
    assign!(user, role)
    Authz.build_actor(user)
  end

  defp upload_params(src, extra \\ %{}) do
    Map.merge(
      %{path: src, filename: "合同.pdf", content_type: "application/pdf"},
      extra
    )
  end

  describe "Files.upload/2" do
    test "有 sys.file:create:落库 + 落盘,元数据完整", %{src: src} do
      actor = actor_with!(["sys.file:create"])

      assert {:ok, %{file: file, attachment: nil}} = Files.upload(actor, upload_params(src))

      assert file.storage == "test_local"
      assert file.filename == "合同.pdf"
      assert file.content_type == "application/pdf"
      assert file.size == byte_size("PDF 内容")
      assert file.sha256 == :sha256 |> :crypto.hash("PDF 内容") |> Base.encode16(case: :lower)
      assert file.uploaded_by_id == actor.user_id
      # key 由服务端生成:日期目录 + uuid + 净化后的扩展名,不含原始文件名
      assert file.key =~ ~r|^\d{4}/\d{2}/\d{2}/[0-9a-f-]{36}\.pdf$|
      assert {:ok, "PDF 内容"} = Storage.read(file.storage, file.key)
    end

    test "无权限:拒绝且不留下物理对象", %{src: src, root: root} do
      actor = actor_with!(["sys.file:read"])

      assert {:error, :forbidden} = Files.upload(actor, upload_params(src))
      assert {:ok, []} = File.ls(root)
    end

    test "带 owner 参数:同时创建附件关联", %{src: src} do
      actor = actor_with!(["sys.file:create"])

      assert {:ok, %{file: file, attachment: att}} =
               Files.upload(
                 actor,
                 upload_params(src, %{
                   owner_type: "sal_customer",
                   owner_id: Ash.UUID.generate(),
                   category: "contract"
                 })
               )

      assert att.file_id == file.id
      assert att.owner_type == "sal_customer"
      assert att.category == "contract"
    end

    test "category 缺省为 default", %{src: src} do
      actor = actor_with!(["sys.file:create"])

      assert {:ok, %{attachment: att}} =
               Files.upload(
                 actor,
                 upload_params(src, %{owner_type: "sal_customer", owner_id: Ash.UUID.generate()})
               )

      assert att.category == "default"
    end
  end

  describe "附件查询与删除" do
    setup %{src: src} do
      actor = actor_with!(["sys.file:create", "sys.file:read", "sys.file:delete"])
      owner_id = Ash.UUID.generate()

      {:ok, %{file: file, attachment: att}} =
        Files.upload(actor, upload_params(src, %{owner_type: "sal_customer", owner_id: owner_id}))

      # :file 是 ExUnit context 保留字段,换名
      %{actor: actor, owner_id: owner_id, stored: file, att: att}
    end

    test "按 owner 过滤可查到附件(带 file 元数据)", %{actor: actor, owner_id: owner_id, att: att} do
      results =
        Attachment
        |> Ash.Query.filter_input(%{owner_type: "sal_customer", owner_id: owner_id})
        |> Ash.Query.load(:file)
        |> Ash.read!(actor: actor)

      assert [%{id: id, file: %{filename: "合同.pdf"}}] = results
      assert id == att.id
    end

    test "无 sys.file:read 查询被拒", %{owner_id: owner_id} do
      nobody = actor_with!([])

      assert {:error, %Ash.Error.Forbidden{}} =
               Attachment
               |> Ash.Query.filter_input(%{owner_type: "sal_customer", owner_id: owner_id})
               |> Ash.read(actor: nobody)
    end

    test "文件仍被附件引用时删除被 FK 挡住", %{actor: actor, stored: file} do
      assert {:error, _} = Ash.destroy(file, actor: actor)
    end

    test "先删附件再删文件,物理对象同步清理", %{actor: actor, stored: file, att: att} do
      :ok = Ash.destroy!(att, actor: actor)
      :ok = Ash.destroy!(file, actor: actor)

      assert {:error, :not_found} = Storage.read(file.storage, file.key)
    end
  end

  test "权限目录含 sys.file 组" do
    assert %{prefix: "sys.file", actions: ~w(create read delete)} in SynieCore.Authz.Registry.catalog()
  end
end
