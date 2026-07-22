defmodule SynieCore.StorageTest do
  use ExUnit.Case, async: true

  require Ash.Query

  alias SynieCore.Files.StorageEndpoint
  alias SynieCore.Storage

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)

    base =
      Path.join(System.tmp_dir!(), "synie_storage_test_#{System.unique_integer([:positive])}")

    root = Path.join(base, "objects")
    File.mkdir_p!(root)

    src = Path.join(base, "src.bin")
    File.write!(src, "hello 附件")

    on_exit(fn -> File.rm_rf!(base) end)

    %{root: root, src: src}
  end

  defp endpoint!(attrs, opts \\ []) do
    changeset = Ash.Changeset.for_create(StorageEndpoint, :create, attrs)

    changeset =
      Enum.reduce(Keyword.take(opts, [:is_default]), changeset, fn {k, v}, cs ->
        Ash.Changeset.force_change_attribute(cs, k, v)
      end)

    Ash.create!(changeset, authorize?: false)
  end

  describe "Local adapter 经门面(DB 行驱动)" do
    setup %{root: root} do
      endpoint!(%{name: "test_local", label: "测试本地", kind: :local, root: root})
      :ok
    end

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
  end

  test "未配置的存储名直接抛错", %{src: src} do
    assert_raise ArgumentError, ~r/nope/, fn -> Storage.put("nope", "k.bin", src) end
  end

  describe "default/0" do
    test "返回默认接入名(字符串,可直接入库)", %{root: root} do
      endpoint!(%{name: "def_local", label: "默认", kind: :local, root: root}, is_default: true)
      assert Storage.default() == "def_local"
    end

    test "无默认行时抛错提示完成初始化向导" do
      assert_raise RuntimeError, ~r/初始化向导|存储接入/, fn -> Storage.default() end
    end
  end
end
