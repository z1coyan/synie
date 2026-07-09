defmodule SynieCore.StorageTest do
  # 改全局 Application env,不能 async
  use ExUnit.Case, async: false

  alias SynieCore.Storage

  setup do
    base = Path.join(System.tmp_dir!(), "synie_storage_test_#{System.unique_integer([:positive])}")
    root = Path.join(base, "objects")
    File.mkdir_p!(root)

    src = Path.join(base, "src.bin")
    File.write!(src, "hello 附件")

    old = Application.fetch_env(:synie_core, :storages)

    Application.put_env(:synie_core, :storages,
      test_local: %{adapter: SynieCore.Storage.Local, root: root}
    )

    on_exit(fn ->
      File.rm_rf!(base)

      case old do
        {:ok, v} -> Application.put_env(:synie_core, :storages, v)
        :error -> Application.delete_env(:synie_core, :storages)
      end
    end)

    %{root: root, src: src}
  end

  describe "Local adapter 经门面" do
    test "put 后 read 取回原内容", %{src: src} do
      assert :ok = Storage.put("test_local", "2026/07/a.bin", src)
      assert {:ok, "hello 附件"} = Storage.read("test_local", "2026/07/a.bin")
    end

    test "delete 幂等,删除后 read 报 :not_found", %{src: src} do
      :ok = Storage.put("test_local", "k.bin", src)
      assert :ok = Storage.delete("test_local", "k.bin")
      assert {:error, :not_found} = Storage.read("test_local", "k.bin")
      assert :ok = Storage.delete("test_local", "k.bin")
    end

    test "key 越出 root 时拒绝", %{src: src, root: root} do
      assert {:error, :invalid_key} = Storage.put("test_local", "../escape.bin", src)
      assert {:error, :invalid_key} = Storage.read("test_local", "../../etc/passwd")
      refute File.exists?(Path.join(Path.dirname(root), "escape.bin"))
    end

    test "本地存储不支持预签名" do
      assert {:error, :unsupported} = Storage.presigned_url("test_local", "k.bin", :get, 300)
    end

    test "未配置的存储名直接抛错", %{src: src} do
      assert_raise ArgumentError, ~r/nope/, fn -> Storage.put("nope", "k.bin", src) end
    end
  end

  describe "default/0" do
    test "返回 :default_storage 配置对应的名字(字符串,可直接入库)" do
      old = Application.fetch_env(:synie_core, :default_storage)
      Application.put_env(:synie_core, :default_storage, :test_local)

      on_exit(fn ->
        case old do
          {:ok, v} -> Application.put_env(:synie_core, :default_storage, v)
          :error -> Application.delete_env(:synie_core, :default_storage)
        end
      end)

      assert Storage.default() == "test_local"
    end
  end
end
