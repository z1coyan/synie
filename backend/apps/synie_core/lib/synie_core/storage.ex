defmodule SynieCore.Storage do
  @moduledoc """
  文件存储门面:按配置名把操作分发给对应 adapter。

  配置(runtime.exs):

      config :synie_core, :storages,
        local: %{adapter: SynieCore.Storage.Local, root: "/var/synie/uploads"}

      config :synie_core, :default_storage, :local

  存储名以字符串形式入库(`sys_file.storage`);换 bucket/endpoint 时新增一个
  配置名,旧文件行仍指向旧配置,无需迁移数据。
  """

  @doc "默认存储名(字符串,可直接写入 sys_file.storage)。"
  @spec default() :: String.t()
  def default, do: Application.fetch_env!(:synie_core, :default_storage) |> to_string()

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
    storages = Application.fetch_env!(:synie_core, :storages)

    case Enum.find(storages, fn {k, _} -> to_string(k) == name end) do
      {_, %{adapter: adapter} = config} -> {adapter, config}
      nil -> raise ArgumentError, "未配置的存储:#{inspect(name)},检查 :synie_core, :storages"
    end
  end
end
