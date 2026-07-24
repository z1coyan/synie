defmodule SynieWeb.Test.GridDoc do
  @moduledoc """
  最小 Ash 资源,仅供 GridMeta.build/2 的扩展动作机制测试使用。

  不挂域(domain: nil)、不接数据层校验(Ash.DataLayer.Simple):
  测试只做反射(列/权限/扩展动作描述符),不执行任何 action,不需要真实持久化。
  """

  use Ash.Resource,
    domain: nil,
    validate_domain_inclusion?: false,
    data_layer: Ash.DataLayer.Simple

  actions do
    defaults([:read])
  end

  attributes do
    uuid_primary_key(:id)

    attribute :title, :string do
      public?(true)
      description("标题")
    end
  end

  def permission_prefix, do: "test.grid_doc"
  def permission_actions, do: ~w(read audit close)

  def grid_actions do
    [
      %{key: "audit", label: "审核", scope: "row", mutation: "auditGridDoc", is_danger: false},
      %{key: "close", label: "关闭", scope: "both", mutation: "closeGridDoc", is_danger: true}
    ]
  end
end
