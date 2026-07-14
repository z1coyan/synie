defmodule SynieCore.Storage.Adapter do
  @moduledoc """
  存储后端 behaviour。实现:`SynieCore.Storage.Local`;
  未来 S3/阿里云 OSS(S3 兼容 API)共用一个 S3 adapter,换 endpoint 配置即可。
  """

  @typedoc "单个存储的配置(由 SynieCore.Storage 从 sys_storage 行构建),字段随 adapter 而异"
  @type config :: map()

  @doc "把本地文件 `src_path` 写入对象 `key`(上传源总是 Plug.Upload 的临时文件)。"
  @callback put(config(), key :: String.t(), src_path :: Path.t()) :: :ok | {:error, term()}

  @doc "读取对象全部内容。附件量级直接读内存;大文件流式下载留给需要时。"
  @callback read(config(), key :: String.t()) :: {:ok, binary()} | {:error, term()}

  @doc "删除对象,幂等(不存在也返回 :ok)。"
  @callback delete(config(), key :: String.t()) :: :ok | {:error, term()}

  @doc "生成预签名 URL;不支持的后端(本地磁盘)返回 {:error, :unsupported}。"
  @callback presigned_url(config(), key :: String.t(), :get | :put, ttl_seconds :: pos_integer()) ::
              {:ok, String.t()} | {:error, :unsupported}
end
