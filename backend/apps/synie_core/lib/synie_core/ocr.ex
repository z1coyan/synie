defmodule SynieCore.Ocr do
  @moduledoc """
  票据 OCR 门面:校验并读取文件字节 → 调阿里云 → 映射为前端表单字段。
  凭证在 acc_setting(财务→财务设置)。仅允许识别本人上传的文件——
  OCR 动线里文件是刚上传的裸文件(未挂宿主),放开会让任意 file_id 可被探测。
  """

  alias SynieCore.Acc.Setting
  alias SynieCore.Files.File, as: StoredFile
  alias SynieCore.Ocr.AcceptanceMapper
  alias SynieCore.Ocr.AliyunClient
  alias SynieCore.Ocr.InvoiceMapper
  alias SynieCore.Storage

  # 与阿里云限制一致:二进制 body ≤10MB
  @max_size 10 * 1024 * 1024
  @image_types ~w(image/png image/jpg image/jpeg image/bmp image/gif image/tiff image/webp)

  @spec recognize_invoice(SynieCore.Authz.Actor.t(), String.t()) ::
          {:ok, map()} | {:error, String.t()}
  def recognize_invoice(actor, file_id) do
    # 发票接口额外支持 PDF(数电票常见)
    with {:ok, binary} <- fetch_binary(actor, file_id, @image_types ++ ["application/pdf"]),
         {:ok, creds} <- credentials(),
         {:ok, data} <- AliyunClient.recognize("RecognizeInvoice", binary, creds) do
      {:ok, InvoiceMapper.map(data)}
    end
  end

  @spec recognize_bank_acceptance(SynieCore.Authz.Actor.t(), String.t()) ::
          {:ok, map()} | {:error, String.t()}
  def recognize_bank_acceptance(actor, file_id) do
    with {:ok, binary} <- fetch_binary(actor, file_id, @image_types),
         {:ok, creds} <- credentials(),
         {:ok, data} <- AliyunClient.recognize("RecognizeBankAcceptance", binary, creds) do
      {:ok, AcceptanceMapper.map(data)}
    end
  end

  defp credentials do
    case Setting.get() do
      %Setting{ocr_access_key_id: ak, ocr_access_key_secret: sk}
      when is_binary(ak) and ak != "" and is_binary(sk) and sk != "" ->
        {:ok, %{access_key_id: ak, access_key_secret: sk}}

      _ ->
        {:error, "未配置阿里云 OCR 凭证,请到「财务→财务设置」配置"}
    end
  end

  defp fetch_binary(actor, file_id, allowed_types) do
    with {:ok, file} <- fetch_file(actor, file_id),
         :ok <- check_uploader(actor, file),
         :ok <- check_type(file, allowed_types),
         :ok <- check_size(file) do
      case Storage.read(file.storage, file.key) do
        {:ok, binary} -> {:ok, binary}
        {:error, _} -> {:error, "文件对象读取失败,请重新上传"}
      end
    end
  end

  defp fetch_file(actor, file_id) do
    case Ash.get(StoredFile, file_id, actor: actor) do
      {:ok, file} -> {:ok, file}
      {:error, _} -> {:error, "文件不存在或无权访问"}
    end
  end

  defp check_uploader(actor, file) do
    if actor.super_admin or actor.user_id == file.uploaded_by_id do
      :ok
    else
      {:error, "仅能识别本人上传的文件"}
    end
  end

  defp check_type(file, allowed_types) do
    if file.content_type in allowed_types do
      :ok
    else
      {:error, "不支持的文件格式:#{file.content_type || "未知"}(支持 #{Enum.join(allowed_types, "、")})"}
    end
  end

  defp check_size(%{size: size}) when is_integer(size) and size > @max_size,
    do: {:error, "文件超过 10MB,请压缩后重试"}

  defp check_size(_), do: :ok
end
