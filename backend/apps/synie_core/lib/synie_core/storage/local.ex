defmodule SynieCore.Storage.Local do
  @moduledoc "本地磁盘存储:对象即 root 下按 key 的文件。配置:%{adapter: __MODULE__, root: 目录}。"

  @behaviour SynieCore.Storage.Adapter

  @impl true
  def put(%{root: root}, key, src_path) do
    with {:ok, dest} <- safe_path(root, key) do
      File.mkdir_p!(Path.dirname(dest))

      case File.cp(src_path, dest) do
        :ok -> :ok
        {:error, reason} -> {:error, reason}
      end
    end
  end

  @impl true
  def read(%{root: root}, key) do
    with {:ok, path} <- safe_path(root, key) do
      case File.read(path) do
        {:ok, bin} -> {:ok, bin}
        {:error, :enoent} -> {:error, :not_found}
        {:error, reason} -> {:error, reason}
      end
    end
  end

  @impl true
  def delete(%{root: root}, key) do
    with {:ok, path} <- safe_path(root, key) do
      case File.rm(path) do
        :ok -> :ok
        {:error, :enoent} -> :ok
        {:error, reason} -> {:error, reason}
      end
    end
  end

  @impl true
  def presigned_url(_config, _key, _method, _ttl), do: {:error, :unsupported}

  # key 虽由服务端生成,防线仍留:展开后必须落在 root 内,否则拒绝
  defp safe_path(root, key) do
    root = Path.expand(root)
    path = Path.expand(Path.join(root, key))

    if String.starts_with?(path, root <> "/") do
      {:ok, path}
    else
      {:error, :invalid_key}
    end
  end
end
