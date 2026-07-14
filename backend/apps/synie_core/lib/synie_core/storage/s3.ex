defmodule SynieCore.Storage.S3 do
  @moduledoc """
  S3 兼容对象存储 adapter:AWS S3、MinIO、阿里云 OSS(S3 兼容 API)共用。
  配置由 `SynieCore.Storage` 从 sys_storage 行构建:
  `%{kind, endpoint, region, bucket, prefix, access_key_id, secret_access_key}`。
  寻址:kind=oss 用 virtual-host(OSS 要求),其余 path-style(MinIO/AWS 均可);
  region 缺省按 us-east-1 签名。上传上限 50MB(路由层),单次 put_object 足够。
  """

  @behaviour SynieCore.Storage.Adapter

  alias ExAws.S3

  @impl true
  def put(config, key, src_path) do
    case request(S3.put_object(config.bucket, full_key(config, key), File.read!(src_path)), config) do
      {:ok, _} -> :ok
      {:error, reason} -> {:error, reason}
    end
  end

  @impl true
  def read(config, key) do
    case request(S3.get_object(config.bucket, full_key(config, key)), config) do
      {:ok, %{body: body}} -> {:ok, body}
      {:error, {:http_error, 404, _}} -> {:error, :not_found}
      {:error, reason} -> {:error, reason}
    end
  end

  @impl true
  def delete(config, key) do
    # S3 DeleteObject 天然幂等:对象不存在同样 204
    case request(S3.delete_object(config.bucket, full_key(config, key)), config) do
      {:ok, _} -> :ok
      {:error, reason} -> {:error, reason}
    end
  end

  @impl true
  def presigned_url(config, key, method, ttl_seconds) when method in [:get, :put] do
    S3.presigned_url(ex_aws_config(config), method, config.bucket, full_key(config, key),
      expires_in: ttl_seconds,
      virtual_host: virtual_host?(config)
    )
  end

  @doc "prefix 作「默认路径」拼在服务端生成的 key 前;斜杠归一,空 prefix 原样返回 key。"
  def full_key(%{prefix: prefix}, key) when is_binary(prefix) do
    case String.trim(prefix, "/") do
      "" -> key
      trimmed -> trimmed <> "/" <> key
    end
  end

  def full_key(_config, key), do: key

  defp virtual_host?(%{kind: :oss}), do: true
  defp virtual_host?(_config), do: false

  defp request(op, config) do
    ExAws.request(op, config_overrides(config))
  end

  defp ex_aws_config(config), do: ExAws.Config.new(:s3, config_overrides(config))

  defp config_overrides(config) do
    uri = URI.parse(config.endpoint)
    scheme = uri.scheme || "https"

    [
      access_key_id: config.access_key_id,
      secret_access_key: config.secret_access_key,
      region: presence(config.region) || "us-east-1",
      scheme: scheme <> "://",
      host: uri.host,
      port: uri.port || if(scheme == "http", do: 80, else: 443),
      # ExAws.Operation.S3 按 config.virtual_host 决定 bucket 上主机名还是拼路径
      virtual_host: virtual_host?(config)
    ]
  end

  defp presence(nil), do: nil
  defp presence(v), do: if(String.trim(v) == "", do: nil, else: v)
end
