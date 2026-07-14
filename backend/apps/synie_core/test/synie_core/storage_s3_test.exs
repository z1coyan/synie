defmodule SynieCore.Storage.S3Test do
  use ExUnit.Case, async: true

  alias SynieCore.Storage.S3

  @config %{
    kind: :s3,
    endpoint: "http://127.0.0.1:9000",
    region: nil,
    bucket: "synie",
    prefix: "erp",
    access_key_id: "minioadmin",
    secret_access_key: "minioadmin"
  }

  describe "full_key/2" do
    test "prefix 拼在服务端 key 前,斜杠归一" do
      assert S3.full_key(@config, "2026/07/a.bin") == "erp/2026/07/a.bin"
      assert S3.full_key(%{@config | prefix: "erp/"}, "a.bin") == "erp/a.bin"
      assert S3.full_key(%{@config | prefix: nil}, "a.bin") == "a.bin"
      assert S3.full_key(%{@config | prefix: ""}, "a.bin") == "a.bin"
    end
  end

  describe "presigned_url/4" do
    test "s3(path-style):URL 指向 endpoint 主机,路径含 bucket 与完整 key,带 SigV4 参数" do
      assert {:ok, url} = S3.presigned_url(@config, "2026/07/a.bin", :get, 300)
      uri = URI.parse(url)
      assert uri.host == "127.0.0.1"
      assert uri.port == 9000
      assert uri.path == "/synie/erp/2026/07/a.bin"
      assert url =~ "X-Amz-Signature="
      assert url =~ "X-Amz-Expires=300"
    end

    test "oss(virtual-host):bucket 上主机名,路径不含 bucket" do
      config = %{
        @config
        | kind: :oss,
          endpoint: "https://oss-cn-hangzhou.aliyuncs.com",
          region: "cn-hangzhou"
      }

      assert {:ok, url} = S3.presigned_url(config, "a.bin", :get, 300)
      uri = URI.parse(url)
      assert uri.host == "synie.oss-cn-hangzhou.aliyuncs.com"
      assert uri.path == "/erp/a.bin"
    end
  end

  describe "MinIO 集成(需本地 MinIO,mix test --include minio)" do
    @describetag :minio

    test "put/read/delete 幂等走通" do
      base = Path.join(System.tmp_dir!(), "synie_s3_test_#{System.unique_integer([:positive])}")
      File.mkdir_p!(base)
      src = Path.join(base, "src.bin")
      File.write!(src, "s3 对象内容")
      on_exit(fn -> File.rm_rf!(base) end)

      key = "t/#{System.unique_integer([:positive])}.bin"

      assert :ok = S3.put(@config, key, src)
      assert {:ok, "s3 对象内容"} = S3.read(@config, key)
      assert :ok = S3.delete(@config, key)
      assert {:error, :not_found} = S3.read(@config, key)
      assert :ok = S3.delete(@config, key)
    end
  end
end
