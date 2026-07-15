defmodule SynieCore.Files do
  @moduledoc """
  文件上传编排:生成对象键 → 写存储 → 落 `sys_file`(可选同时挂 `sys_attachment`)。
  下载、删除直接走资源动作与 `SynieCore.Storage` 门面,本模块只管上传这条多步路径。
  """

  alias SynieCore.Files.Attachment
  alias SynieCore.Files.File, as: StoredFile
  alias SynieCore.Files.OwnerRegistry
  alias SynieCore.Storage

  @doc """
  上传一个文件。`params`:

    * `:path` - 本地临时文件(Plug.Upload 落盘位置)
    * `:filename` - 原始文件名
    * `:content_type` - MIME 类型(可空)
    * `:owner_type` / `:owner_id` - 可选,带上则同时创建附件关联
    * `:category` - 可选槽位,缺省 `"default"`

  返回 `{:ok, %{file: file, attachment: attachment | nil}}`。
  """
  @spec upload(SynieCore.Authz.Actor.t(), map()) ::
          {:ok, %{file: StoredFile.t(), attachment: Attachment.t() | nil}} | {:error, term()}
  def upload(actor, %{path: path, filename: filename} = params) do
    # 预检权限,避免无权调用先写对象再回滚;真正的强制仍在资源 policy
    if Ash.can?({StoredFile, :create}, actor) do
      do_upload(actor, path, filename, params)
    else
      {:error, :forbidden}
    end
  end

  defp do_upload(actor, path, filename, params) do
    storage = Storage.default()
    key = gen_key(filename)

    with :ok <- Storage.put(storage, key, path) do
      attrs = %{
        storage: storage,
        key: key,
        filename: filename,
        content_type: params[:content_type],
        size: File.stat!(path).size,
        sha256: sha256(path),
        uploaded_by_id: actor.user_id
      }

      case create_records(actor, attrs, params) do
        {:ok, result} ->
          {:ok, result}

        {:error, err} ->
          Storage.delete(storage, key)
          {:error, err}
      end
    end
  end

  @doc """
  给已有 `sys_file` 补挂宿主附件(OCR 动线:识别时上传裸文件,单据保存成功后回头挂接)。
  `params`:`:file_id` 必填,`:owner_type`/`:owner_id` 必填,`:category` 可选。
  权限语义与上传时顺带挂接一致:actor 要能读文件、能读宿主、有附件 create 权。
  """
  @spec attach(SynieCore.Authz.Actor.t(), map()) ::
          {:ok, Attachment.t()} | {:error, term()}
  def attach(actor, %{file_id: file_id} = params) do
    with {:ok, file} <- fetch_file(actor, file_id),
         :ok <- check_uploader(actor, file),
         {:ok, %Attachment{} = attachment} <- maybe_attach(actor, file, params) do
      {:ok, attachment}
    else
      # maybe_attach 对缺 owner 参数返回 {:ok, nil},此处视为调用错误
      {:ok, nil} -> {:error, :missing_owner}
      {:error, reason} -> {:error, reason}
    end
  rescue
    e in [Ash.Error.Forbidden, Ash.Error.Invalid] -> {:error, e}
  end

  defp fetch_file(actor, file_id) do
    case Ash.get(StoredFile, file_id, actor: actor) do
      {:ok, file} -> {:ok, file}
      {:error, _} -> {:error, :file_not_found}
    end
  end

  # 补挂会改变文件可见性(宿主可见者即可下载),故仅允许上传者本人/超管补挂,
  # 否则持 sys.file:read 的用户可把他人裸文件挂到自己可见的宿主上越权下载
  defp check_uploader(actor, file) do
    if actor.super_admin or actor.user_id == file.uploaded_by_id do
      :ok
    else
      {:error, :not_uploader}
    end
  end

  # file + attachment 同事务,挂接失败(未知宿主/宿主不可见)连文件行一起回滚
  defp create_records(actor, attrs, params) do
    SynieCore.Repo.transaction(fn ->
      # return_notifications?: true 接住通知并丢弃:手动事务里通知无法送达,
      # 这里也无人订阅,不接会刷 missed_notifications 告警
      {file, _notifications} =
        StoredFile
        |> Ash.Changeset.for_create(:create, attrs)
        |> Ash.create!(actor: actor, return_notifications?: true)

      case maybe_attach(actor, file, params) do
        {:ok, attachment} -> %{file: file, attachment: attachment}
        # 走 Repo.rollback 让 transaction 返回 {:error, reason},连文件行一起回滚
        {:error, reason} -> SynieCore.Repo.rollback(reason)
      end
    end)
  rescue
    e in [Ash.Error.Forbidden, Ash.Error.Invalid] -> {:error, e}
  end

  # 挂接前先在白名单里解析宿主模块,再用 actor 读宿主本身:
  # 未知 owner_type → :unknown_owner_type;actor 看不到宿主(无权/不存在)→ :forbidden_owner;
  # 二者都回滚。company_id 从宿主去规范化(全局宿主如客户无该字段 → nil)。
  defp maybe_attach(actor, file, %{owner_type: owner_type, owner_id: owner_id} = params)
       when is_binary(owner_type) and owner_type != "" and is_binary(owner_id) do
    with {:ok, module} <- OwnerRegistry.resolve(owner_type),
         {:ok, host} <- Ash.get(module, owner_id, actor: actor) do
      attrs = %{
        file_id: file.id,
        owner_type: owner_type,
        owner_id: owner_id,
        company_id: Map.get(host, :company_id)
      }

      # category 缺省交给属性默认值,显式传 nil 会撞 allow_nil? false
      attrs =
        case params[:category] do
          nil -> attrs
          category -> Map.put(attrs, :category, category)
        end

      {attachment, _notifications} =
        Attachment
        |> Ash.Changeset.for_create(:create, attrs)
        |> Ash.create!(actor: actor, return_notifications?: true)

      {:ok, attachment}
    else
      :error -> {:error, :unknown_owner_type}
      {:error, _reason} -> {:error, :forbidden_owner}
    end
  end

  defp maybe_attach(_actor, _file, _params), do: {:ok, nil}

  defp gen_key(filename) do
    date = Calendar.strftime(Date.utc_today(), "%Y/%m/%d")
    "#{date}/#{Ash.UUID.generate()}#{safe_ext(filename)}"
  end

  # 扩展名只保留 .字母数字(≤10),其余丢弃——key 永不含用户可控内容
  defp safe_ext(filename) do
    ext = filename |> Path.extname() |> String.downcase()
    if ext =~ ~r/^\.[a-z0-9]{1,10}$/, do: ext, else: ""
  end

  defp sha256(path) do
    path
    |> File.stream!(1024 * 1024)
    |> Enum.reduce(:crypto.hash_init(:sha256), &:crypto.hash_update(&2, &1))
    |> :crypto.hash_final()
    |> Base.encode16(case: :lower)
  end
end
