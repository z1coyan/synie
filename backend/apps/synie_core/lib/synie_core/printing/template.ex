defmodule SynieCore.Printing.Template.ValidateResource do
  @moduledoc "resource 必须在 FieldCatalog 已注册。"

  use Ash.Resource.Validation

  @impl true
  def validate(changeset, _opts, _context) do
    resource = Ash.Changeset.get_attribute(changeset, :resource)

    if resource in SynieCore.Printing.FieldCatalog.resources() do
      :ok
    else
      {:error, field: :resource, message: "不支持的资源类型 #{resource}"}
    end
  end
end

defmodule SynieCore.Printing.Template.ValidateFile do
  @moduledoc "校验模板文件为 xlsx 且占位符均在字段清单内。"

  use Ash.Resource.Validation

  @impl true
  def validate(changeset, _opts, _context) do
    file_id =
      Ash.Changeset.get_attribute(changeset, :file_id) ||
        Map.get(changeset.data, :file_id)

    resource =
      Ash.Changeset.get_attribute(changeset, :resource) ||
        Map.get(changeset.data, :resource)

    cond do
      is_nil(file_id) ->
        {:error, field: :file_id, message: "请上传模板文件"}

      is_nil(resource) ->
        :ok

      true ->
        case read_and_validate(file_id, resource) do
          :ok -> :ok
          {:error, msg} -> {:error, field: :file_id, message: msg}
        end
    end
  end

  defp read_and_validate(file_id, resource) do
    with {:ok, file} <- Ash.get(SynieCore.Files.File, file_id, authorize?: false),
         :ok <- check_xlsx_filename(file.filename),
         {:ok, binary} <- SynieCore.Storage.read(file.storage, file.key),
         {:ok, %{fields: fields, nested: nested}} <-
           SynieCore.Printing.Renderer.extract_placeholders(binary) do
      SynieCore.Printing.FieldCatalog.validate_placeholders(resource, fields, nested)
    else
      {:error, %Ash.Error.Query.NotFound{}} ->
        {:error, "模板文件不存在"}

      {:error, {:invalid_template, msg}} ->
        {:error, "无法解析模板: #{msg}"}

      {:error, msg} when is_binary(msg) ->
        {:error, msg}

      {:error, _} ->
        {:error, "无法读取模板文件"}
    end
  end

  defp check_xlsx_filename(name) when is_binary(name) do
    if String.ends_with?(String.downcase(name), ".xlsx") do
      :ok
    else
      {:error, "只接受 .xlsx 模板文件"}
    end
  end

  defp check_xlsx_filename(_), do: {:error, "只接受 .xlsx 模板文件"}
end

defmodule SynieCore.Printing.Template.SetDefault do
  @moduledoc "同 resource 至多一个默认：先清其它再置本行。"

  use Ash.Resource.Change

  require Ash.Query

  @impl true
  def change(changeset, _opts, _context) do
    changeset
    |> Ash.Changeset.before_action(fn changeset ->
      resource = changeset.data.resource

      SynieCore.Printing.Template
      |> Ash.Query.filter(
        resource == ^resource and is_default == true and id != ^changeset.data.id
      )
      |> Ash.read!(authorize?: false)
      |> Enum.each(fn t ->
        t
        |> Ash.Changeset.for_update(:unset_default, %{})
        |> Ash.update!(authorize?: false)
      end)

      changeset
    end)
    |> Ash.Changeset.force_change_attribute(:is_default, true)
  end
end

defmodule SynieCore.Printing.Template.SyncFileAttachment do
  @moduledoc """
  模板文件挂 `sys_attachment`(owner_type `sys_print_template`),使下载授权走
  `sys.print_template:read` 而非「仅上传者/超管」的裸文件规则(见
  `.scratch/print-template-master/spec.md`)。create/update 后(after_action,
  在动作事务内)对齐挂接与当前 `file_id`:已有且一致则不动,换文件则整删重建,
  没有则新建。模板全局无公司维度,不传 `company_id`(留空按 `is_nil(company_id)`
  全站可见,再由权限码把关)。

  挂接的建删是宿主自管自身挂接,受信内部路径,`authorize?: false`(同先例见
  `SynieCore.Sales.OrderItem.SyncDrawings`)。
  """

  use Ash.Resource.Change

  require Ash.Query

  alias SynieCore.Files.Attachment

  @impl true
  def change(changeset, _opts, _context) do
    Ash.Changeset.after_action(changeset, fn _changeset, template ->
      sync!(template)
      {:ok, template}
    end)
  end

  @doc false
  def sync!(template) do
    existing =
      Attachment
      |> Ash.Query.filter(owner_type == "sys_print_template" and owner_id == ^template.id)
      |> Ash.read!(authorize?: false)

    case existing do
      [%Attachment{file_id: file_id}] when file_id == template.file_id ->
        :ok

      rows ->
        Enum.each(rows, &Ash.destroy!(&1, authorize?: false))
        create!(template)
    end
  end

  defp create!(template) do
    Attachment
    |> Ash.Changeset.for_create(:create, %{
      file_id: template.file_id,
      owner_type: "sys_print_template",
      owner_id: template.id,
      category: "template"
    })
    |> Ash.create!(authorize?: false)

    :ok
  end
end

defmodule SynieCore.Printing.Template.ClearFileAttachment do
  @moduledoc """
  模板 destroy 后清理其全部文件挂接(容错同 owner 多行);旧文件回归裸文件,
  由文件管理页/上传者处置去留(文件字节 GC 不在本资源职责内)。
  """

  use Ash.Resource.Change

  require Ash.Query

  alias SynieCore.Files.Attachment

  @impl true
  def change(changeset, _opts, _context) do
    Ash.Changeset.after_action(changeset, fn _changeset, template ->
      clear!(template.id)
      {:ok, template}
    end)
  end

  @doc false
  def clear!(template_id) do
    Attachment
    |> Ash.Query.filter(owner_type == "sys_print_template" and owner_id == ^template_id)
    |> Ash.read!(authorize?: false)
    |> Enum.each(&Ash.destroy!(&1, authorize?: false))
  end
end

defmodule SynieCore.Printing.Template do
  @moduledoc """
  打印模板主数据 `sys_print_template`。全局共享、多模板+单默认；
  上传即校验占位符。见 docs/adr/2026-07-23-print-template.md。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    fragments: [SynieCore.Audit.Fragment]

  postgres do
    table "sys_print_template"
    repo SynieCore.Repo

    custom_indexes do
      index [:is_default, :resource],
        unique: true,
        where: "is_default",
        name: "sys_print_template_one_default_per_resource_index"
    end
  end

  graphql do
    type :sys_print_template
  end

  policies do
    bypass actor_attribute_equals(:super_admin, true) do
      authorize_if always()
    end

    policy action([:read, :create, :update, :destroy]) do
      authorize_if SynieCore.Authz.Checks.HasPermission
    end

    policy action([:set_default, :unset_default]) do
      authorize_if {SynieCore.Authz.Checks.HasPermission, as: "update"}
    end
  end

  def permission_prefix, do: "sys.print_template"
  def permission_label, do: "打印模板"
  def permission_actions, do: ~w(create read update delete)

  def display_field, do: :name

  actions do
    read :read do
      primary? true

      pagination offset?: true,
                 countable: true,
                 required?: false,
                 default_limit: 20,
                 max_page_size: 200
    end

    create :create do
      accept [:name, :resource, :file_id, :remarks]

      validate {SynieCore.Printing.Template.ValidateResource, []}
      validate {SynieCore.Printing.Template.ValidateFile, []}
      change {SynieCore.Printing.Template.SyncFileAttachment, []}
    end

    update :update do
      accept [:name, :file_id, :remarks]
      require_atomic? false

      # resource 创建后不可改
      validate {SynieCore.Printing.Template.ValidateFile, []}
      change {SynieCore.Printing.Template.SyncFileAttachment, []}
    end

    update :set_default do
      accept []
      require_atomic? false
      change {SynieCore.Printing.Template.SetDefault, []}
    end

    update :unset_default do
      accept []
      require_atomic? false
      change set_attribute(:is_default, false)
    end

    destroy :destroy do
      primary? true
      require_atomic? false
      change {SynieCore.Printing.Template.ClearFileAttachment, []}
    end
  end

  attributes do
    uuid_primary_key :id

    attribute :name, :string do
      allow_nil? false
      public? true
      constraints max_length: 64
      description "模板名称"
    end

    attribute :resource, :string do
      allow_nil? false
      public? true
      constraints max_length: 64
      description "绑定资源"
    end

    attribute :is_default, :boolean do
      allow_nil? false
      public? true
      default false
      description "默认模板"
    end

    attribute :remarks, :string do
      allow_nil? true
      public? true
      description "备注"
    end

    create_timestamp :inserted_at, public?: true, description: "创建时间"
    update_timestamp :updated_at, public?: true, description: "更新时间"
  end

  relationships do
    belongs_to :file, SynieCore.Files.File do
      allow_nil? false
      public? true
      attribute_public? true
      description "模板文件"
    end
  end
end
