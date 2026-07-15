defmodule SynieWeb.FileController do
  @moduledoc """
  文件 REST 端点(multipart 不过 GraphQL):

    * `POST /api/files` — 上传,可选 `owner_type`/`owner_id`/`category` 同请求挂附件
    * `GET /api/files/:id` — 下载;支持预签名的存储 302 直达,本地存储回源发送
    * `POST /api/files/:id/attachments` — 给已有文件补挂宿主附件
  """

  use Phoenix.Controller, formats: [:json]

  import Plug.Conn

  require Ash.Query

  alias SynieCore.Files.Attachment
  alias SynieCore.Files.File, as: StoredFile
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
          json(conn, %{
            file: file_json(file),
            attachment: attachment && attachment_json(attachment)
          })

        {:error, :forbidden} ->
          error(conn, 403, "forbidden")

        # actor 看不到宿主(无权/不存在)→ 拒绝挂接
        {:error, :forbidden_owner} ->
          error(conn, 403, "无权访问该宿主记录")

        # owner_type 不在 OwnerRegistry 白名单
        {:error, :unknown_owner_type} ->
          error(conn, 422, "未知的宿主类型")

        {:error, err} when is_exception(err) ->
          error(conn, 422, Exception.message(err))

        {:error, _err} ->
          error(conn, 422, "上传失败")
      end
    end)
  end

  def create(conn, _params), do: error(conn, 400, "缺少 file 字段(multipart)")

  def attach(conn, %{"id" => id} = params) do
    with_actor(conn, fn actor ->
      result =
        SynieCore.Files.attach(actor, %{
          file_id: id,
          owner_type: params["owner_type"],
          owner_id: params["owner_id"],
          category: params["category"]
        })

      case result do
        {:ok, attachment} ->
          json(conn, %{attachment: attachment_json(attachment)})

        {:error, :file_not_found} ->
          error(conn, 404, "文件不存在或无权访问")

        {:error, :not_uploader} ->
          error(conn, 403, "仅能挂接本人上传的文件")

        {:error, :missing_owner} ->
          error(conn, 400, "缺少 owner_type/owner_id 参数")

        {:error, :forbidden_owner} ->
          error(conn, 403, "无权访问该宿主记录")

        {:error, :unknown_owner_type} ->
          error(conn, 422, "未知的宿主类型")

        {:error, err} when is_exception(err) ->
          error(conn, 422, Exception.message(err))
      end
    end)
  end

  def show(conn, %{"id" => id}) do
    with_actor(conn, fn actor ->
      case Ash.get(StoredFile, id, actor: actor) do
        {:ok, file} ->
          if authorized_download?(actor, file) do
            send_stored(conn, file)
          else
            error(conn, 403, "forbidden")
          end

        {:error, %Ash.Error.Forbidden{}} ->
          error(conn, 403, "forbidden")

        {:error, _} ->
          error(conn, 404, "not found")
      end
    end)
  end

  # 下载授权(宿主可见性,不是裸 sys.file:read):
  #   - actor 能看见该文件的任一附件(附件读已按公司过滤)→ 授权;
  #   - 文件完全无附件(裸文件)→ 仅上传人或 super_admin;
  #   - 其余(附件全在他司,actor 一条都看不见)→ 403。
  defp authorized_download?(actor, file) do
    visible =
      Attachment
      |> Ash.Query.filter(file_id == ^file.id)
      |> Ash.read!(actor: actor)

    cond do
      visible != [] -> true
      bare_file?(file.id) -> actor.super_admin || actor.user_id == file.uploaded_by_id
      true -> false
    end
  end

  # 文件是否完全没有附件(权威判断,不受公司作用域)——区分"裸文件"与"附件全在他司";
  # 受信内部读:仅用于下载授权决策,不返回附件数据。
  defp bare_file?(file_id) do
    Attachment
    |> Ash.Query.filter(file_id == ^file_id)
    |> Ash.read!(authorize?: false)
    |> Enum.empty?()
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
