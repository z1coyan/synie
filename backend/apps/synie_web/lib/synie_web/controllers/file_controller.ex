defmodule SynieWeb.FileController do
  @moduledoc """
  文件 REST 端点(multipart 不过 GraphQL):

    * `POST /api/files` — 上传,可选 `owner_type`/`owner_id`/`category` 同请求挂附件
    * `GET /api/files/:id` — 下载;支持预签名的存储 302 直达,本地存储回源发送
  """

  use Phoenix.Controller, formats: [:json]

  import Plug.Conn

  alias SynieCore.Storage

  def create(conn, %{"file" => %Plug.Upload{} = upload} = params) do
    with_actor(conn, fn actor ->
      result =
        SynieCore.Files.upload(actor, %{
          path: upload.path,
          filename: upload.filename,
          content_type: upload.content_type,
          owner_type: params["owner_type"],
          owner_id: params["owner_id"],
          category: params["category"]
        })

      case result do
        {:ok, %{file: file, attachment: attachment}} ->
          json(conn, %{file: file_json(file), attachment: attachment && attachment_json(attachment)})

        {:error, :forbidden} ->
          error(conn, 403, "forbidden")

        {:error, err} ->
          error(conn, 422, Exception.message(err))
      end
    end)
  end

  def create(conn, _params), do: error(conn, 400, "缺少 file 字段(multipart)")

  def show(conn, %{"id" => id}) do
    with_actor(conn, fn actor ->
      case Ash.get(SynieCore.Files.File, id, actor: actor) do
        {:ok, file} ->
          send_stored(conn, file)

        {:error, %Ash.Error.Forbidden{}} ->
          error(conn, 403, "forbidden")

        {:error, _} ->
          error(conn, 404, "not found")
      end
    end)
  end

  defp send_stored(conn, file) do
    case Storage.presigned_url(file.storage, file.key, :get, 300) do
      {:ok, url} ->
        redirect(conn, external: url)

      {:error, :unsupported} ->
        case Storage.read(file.storage, file.key) do
          {:ok, bin} ->
            conn
            |> put_resp_content_type(file.content_type || "application/octet-stream")
            |> put_resp_header("content-disposition", disposition(file.filename))
            |> put_resp_header("x-content-type-options", "nosniff")
            |> send_resp(200, bin)

          {:error, _} ->
            error(conn, 404, "对象缺失")
        end
    end
  end

  # RFC 5987,文件名可含中文
  defp disposition(filename) do
    "attachment; filename*=UTF-8''#{URI.encode(filename, &URI.char_unreserved?/1)}"
  end

  defp with_actor(conn, fun) do
    case Ash.PlugHelpers.get_actor(conn) do
      nil -> error(conn, 401, "unauthorized")
      actor -> fun.(actor)
    end
  end

  defp error(conn, status, message) do
    conn |> put_status(status) |> json(%{error: message})
  end

  defp file_json(file) do
    %{
      id: file.id,
      filename: file.filename,
      contentType: file.content_type,
      size: file.size,
      sha256: file.sha256,
      insertedAt: file.inserted_at
    }
  end

  defp attachment_json(attachment) do
    %{
      id: attachment.id,
      fileId: attachment.file_id,
      ownerType: attachment.owner_type,
      ownerId: attachment.owner_id,
      category: attachment.category
    }
  end
end
