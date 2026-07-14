defmodule SynieCore.Files.StorageKind do
  @moduledoc "存储接入类型。oss 走 S3 兼容 API,与 s3 共用 adapter,仅寻址风格不同。"

  use Ash.Type.Enum, values: [local: "本地磁盘", s3: "S3 兼容", oss: "阿里云 OSS"]

  def graphql_type(_), do: :sys_storage_kind
end
