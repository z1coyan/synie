defmodule SynieCore.Sys.Setting do
  @moduledoc """
  系统设置,对应 `sys_setting` 单行表:系统级全局配置(非公司维度)统一加字段进这张表,
  不另建配置表(同 acc_setting/sal_setting 先例)。行由迁移 seed、恒存在——不开放
  create/destroy,只有 read/update。当前字段:初始化完成时刻(空 = 未初始化,初始化向导开放)。

  不注册 GraphQL、不声明 permission_prefix:读写都走 `SynieCore.Setup` 受信内部路径
  (`authorize?: false`),常态 actor 经 HasPermission 一律 fail-closed。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    authorizers: [Ash.Policy.Authorizer],
    fragments: [SynieCore.Audit.Fragment]

  postgres do
    table "sys_setting"
    repo SynieCore.Repo
  end

  policies do
    bypass actor_attribute_equals(:super_admin, true) do
      authorize_if always()
    end

    policy always() do
      authorize_if SynieCore.Authz.Checks.HasPermission
    end
  end

  actions do
    read :read do
      primary? true
    end

    update :update do
      accept [:setup_completed_at]
      require_atomic? false
    end
  end

  attributes do
    uuid_primary_key :id

    attribute :setup_completed_at, :utc_datetime_usec do
      public? true
      description "初始化完成时刻"
    end

    create_timestamp :inserted_at
    update_timestamp :updated_at
  end

  @doc "取单行配置(受信内部读;迁移 seed 保证存在,nil 仅见于异常环境)。"
  @spec get() :: %__MODULE__{} | nil
  def get do
    __MODULE__ |> Ash.read!(authorize?: false) |> List.first()
  end
end
