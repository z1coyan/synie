defmodule SynieCore.Storage do
  @moduledoc """
  文件存储门面:按接入名(`sys_storage.name`)把操作分发给对应 adapter。

  接入点在系统管理→存储接入维护;`sys_file.storage` 存接入名,换 bucket/endpoint 时
  新增一个接入点,旧文件行仍指向旧接入,无需迁移数据。
  """

  require Ash.Query

  alias SynieCore.Files.StorageEndpoint

  @adapters %{
    local: SynieCore.Storage.Local,
    s3: SynieCore.Storage.S3,
    oss: SynieCore.Storage.S3
  }

  @doc "默认存储名(字符串,可直接写入 sys_file.storage)。"
  @spec default() :: String.t()
  def default do
    StorageEndpoint
    |> Ash.Query.filter(is_default == true)
    |> Ash.read_one(authorize?: false)
    |> case do
      {:ok, %StorageEndpoint{name: name}} -> name
      _ ->
        raise "存储接入未初始化:没有默认接入点,请先完成初始化向导(或在系统管理→存储接入中配置)"
    end
  end

  @spec put(String.t(), String.t(), Path.t()) :: :ok | {:error, term()}
  def put(name, key, src_path) do
    {adapter, config} = conf!(name)
    adapter.put(config, key, src_path)
  end

  @spec read(String.t(), String.t()) :: {:ok, binary()} | {:error, term()}
  def read(name, key) do
    {adapter, config} = conf!(name)
    adapter.read(config, key)
  end

  @spec delete(String.t(), String.t()) :: :ok | {:error, term()}
  def delete(name, key) do
    {adapter, config} = conf!(name)
    adapter.delete(config, key)
  end

  @spec presigned_url(String.t(), String.t(), :get | :put, pos_integer()) ::
          {:ok, String.t()} | {:error, :unsupported}
  def presigned_url(name, key, method, ttl_seconds) when method in [:get, :put] do
    {adapter, config} = conf!(name)
    adapter.presigned_url(config, key, method, ttl_seconds)
  end

  defp conf!(name) do
    StorageEndpoint
    |> Ash.Query.filter(name == ^name)
    |> Ash.read_one(authorize?: false)
    |> case do
      {:ok, %StorageEndpoint{} = ep} -> {Map.fetch!(@adapters, ep.kind), config(ep)}
      _ -> raise ArgumentError, "未知的存储接入:#{inspect(name)},请在系统管理→存储接入中配置"
    end
  end

  defp config(%StorageEndpoint{kind: :local} = ep), do: %{root: ep.root}

  defp config(ep) do
    %{
      kind: ep.kind,
      endpoint: ep.endpoint,
      region: ep.region,
      bucket: ep.bucket,
      prefix: ep.prefix,
      access_key_id: ep.access_key_id,
      secret_access_key: ep.secret_access_key
    }
  end
end
