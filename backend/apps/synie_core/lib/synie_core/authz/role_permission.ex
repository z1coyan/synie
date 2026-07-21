defmodule SynieCore.Authz.RolePermission.BuiltinRoleGuard do
  @moduledoc "内置角色授权守卫:内置角色(如 admin)的授权只读,不可增删。"

  use Ash.Resource.Validation

  require Ash.Query

  @impl true
  def validate(changeset, _opts, _context) do
    # create 取写入值,destroy 取存量值
    role_id =
      Ash.Changeset.get_attribute(changeset, :role_id) ||
        (changeset.data && changeset.data.role_id)

    if role_id && builtin_role?(role_id) do
      {:error, message: "内置角色的授权不可增删"}
    else
      :ok
    end
  end

  defp builtin_role?(role_id) do
    SynieCore.Authz.Role
    |> Ash.Query.filter(id == ^role_id and builtin == true)
    |> Ash.exists?(authorize?: false)
  end
end

defmodule SynieCore.Authz.RolePermission do
  @moduledoc "角色-权限码授权,对应 `sys_role_permission` 表。权限码可为通配(`sales.order:*`、`sales.*`、`*`)。"

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    fragments: [SynieCore.Audit.Fragment]

  postgres do
    table "sys_role_permission"
    repo SynieCore.Repo
  end

  graphql do
    type :sys_role_permission
  end

  policies do
    bypass actor_attribute_equals(:super_admin, true) do
      authorize_if always()
    end

    policy action_type([:create, :read, :destroy]) do
      authorize_if SynieCore.Authz.Checks.HasPermission
    end

    # 整组同步是授权的增删合一:一次调用可能删行,故要求同时具备 create 与 delete
    # 两码(与矩阵编辑门控同口径),不设独立权限点(权限矩阵零噪音)
    policy action(:sync) do
      forbid_unless {SynieCore.Authz.Checks.HasPermission, as: "create"}
      authorize_if {SynieCore.Authz.Checks.HasPermission, as: "delete"}
    end
  end

  def permission_prefix, do: "sys.role_permission"
  def permission_label, do: "角色权限"
  def permission_actions, do: ~w(create read delete)

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
      accept [:role_id, :permission]

      validate SynieCore.Authz.RolePermission.BuiltinRoleGuard
    end

    destroy :destroy do
      primary? true
      require_atomic? false

      validate SynieCore.Authz.RolePermission.BuiltinRoleGuard
    end

    # 权限配置页整组保存:以目标列表为准同步目录内具体码;
    # 存量通配码与目录外码原样保留,内置角色拒绝写入
    action :sync, {:array, :string} do
      argument :role_id, :uuid, allow_nil?: false
      argument :permissions, {:array, :string}, allow_nil?: false

      transaction? true

      run SynieCore.Authz.RolePermissionSync
    end
  end

  attributes do
    uuid_primary_key :id

    attribute :permission, :string do
      allow_nil? false
      public? true
      constraints max_length: 128
    end

    create_timestamp :inserted_at
  end

  relationships do
    belongs_to :role, SynieCore.Authz.Role do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
    end
  end

  identities do
    identity :unique_role_permission, [:role_id, :permission]
  end
end
