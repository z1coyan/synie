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
         {:ok, %{fields: fields, items: items}} <-
           SynieCore.Printing.Renderer.extract_placeholders(binary) do
      SynieCore.Printing.FieldCatalog.validate_placeholders(resource, fields, items)
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
      |> Ash.Query.filter(resource == ^resource and is_default == true and id != ^changeset.data.id)
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
    end

    update :update do
      accept [:name, :file_id, :remarks]
      require_atomic? false

      # resource 创建后不可改
      validate {SynieCore.Printing.Template.ValidateFile, []}
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
