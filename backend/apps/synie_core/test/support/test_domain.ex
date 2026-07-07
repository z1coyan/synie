defmodule SynieCore.Test.Domain do
  @moduledoc "测试专用 Ash 域(ETS 数据层),用于验证策略组件而不依赖真实业务表。"

  use Ash.Domain, validate_config_inclusion?: false

  resources do
    resource SynieCore.Test.Doc
  end
end

defmodule SynieCore.Test.Doc do
  @moduledoc """
  公司范围资源的参考样板:业务资源接入权限的标准写法照抄此处——
  声明 permission_prefix/permission_actions、三段 policies、写入动作挂 CompanyAccessible。
  """

  use Ash.Resource,
    domain: SynieCore.Test.Domain,
    data_layer: Ash.DataLayer.Ets,
    authorizers: [Ash.Policy.Authorizer]

  ets do
    private? true
  end

  def permission_prefix, do: "test.doc"
  def permission_actions, do: ~w(create read delete)

  actions do
    defaults [:read, :destroy]

    create :create do
      accept [:title, :company_id]

      validate {SynieCore.Authz.Validations.CompanyAccessible, []}
    end
  end

  attributes do
    uuid_primary_key :id

    attribute :title, :string, public?: true

    attribute :company_id, :uuid do
      allow_nil? false
      public? true
    end
  end

  policies do
    bypass actor_attribute_equals(:super_admin, true) do
      authorize_if always()
    end

    policy always() do
      authorize_if SynieCore.Authz.Checks.HasPermission
    end

    policy action_type([:read, :update, :destroy]) do
      authorize_if SynieCore.Authz.Checks.CompanyScope
    end
  end
end
