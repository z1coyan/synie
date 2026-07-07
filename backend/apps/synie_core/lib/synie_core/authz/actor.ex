defmodule SynieCore.Authz.Actor do
  @moduledoc """
  请求期权限主体,作为 Ash actor 使用。

  在登录解析后由 `SynieCore.Authz.build_actor/1` 构建,
  携带用户的权限码集合(含通配)与授权公司范围。
  """

  @enforce_keys [:user_id]
  defstruct [
    :user_id,
    :username,
    super_admin: false,
    all_companies: false,
    permissions: MapSet.new(),
    company_ids: []
  ]

  @type t :: %__MODULE__{
          user_id: String.t(),
          username: String.t() | nil,
          super_admin: boolean(),
          all_companies: boolean(),
          permissions: MapSet.t(String.t()),
          company_ids: [String.t()]
        }
end
