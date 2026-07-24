defmodule SynieWeb.AuthzMatrix.Subjects do
  @moduledoc """
  合成极值主体生成器:按资源前缀从**权限目录反射**生成六种极值形态,不手写权限码清单。

  | 形态            | 权限码            | 公司授权       | 预期读侧行为             |
  |-----------------|-------------------|----------------|--------------------------|
  | `:no_code`      | 无                | 公司甲         | 功能权限拒绝(errors)   |
  | `:min_a`        | `前缀:read`       | 公司甲         | 恰好看到甲司应得集       |
  | `:min_b`        | `前缀:read`       | 公司乙         | 恰好看到乙司应得集       |
  | `:no_company`   | `前缀:read`       | 无             | 公司隔离资源空集(fail-closed)|
  | `:all_companies`| `前缀:read`       | 旗标 all_companies | 全部公司应得集       |
  | `:super_admin`  | 无(旗标)        | 无             | 一切可见                 |

  未登录(匿名)不在此生成——它与前缀无关,由矩阵测试单独打无 token 请求。

  每个主体返回真实 Bearer token(`SynieWeb.Auth.sign_token/1`),矩阵经完整 HTTP
  管线(token 验证、上下文 plug)行权。`access` 字段编码主体的生效公司集,
  供应得集 oracle 消费::denied(无码)| :all | {:companies, [id]}。
  """

  alias SynieCore.Accounts.User
  alias SynieCore.Authz.Registry
  alias SynieCore.Authz.{Role, RolePermission, UserCompany, UserRole}

  @doc "按前缀生成六种极值读主体(写侧形态由工单03扩展)。"
  def extreme_read_subjects(prefix, world) do
    read_code = action_code!(prefix, "read")

    [
      %{shape: :no_code, access: :denied, token: token!([], companies: [world.company_a.id])},
      %{
        shape: :min_a,
        access: {:companies, [world.company_a.id]},
        token: token!([read_code], companies: [world.company_a.id])
      },
      %{
        shape: :min_b,
        access: {:companies, [world.company_b.id]},
        token: token!([read_code], companies: [world.company_b.id])
      },
      %{shape: :no_company, access: {:companies, []}, token: token!([read_code])},
      %{shape: :all_companies, access: :all, token: token!([read_code], all_companies: true)},
      %{shape: :super_admin, access: :all, token: token!([], super_admin: true)}
    ]
  end

  @doc """
  从权限目录反射出 `前缀:动作` 权限码;前缀不在目录或未声明该动作时直接抛错
  ——极值主体的码永远来自目录,不允许手写。
  """
  def action_code!(prefix, action) do
    entry =
      Enum.find(Registry.catalog(), &(&1.prefix == prefix)) ||
        raise "权限目录中不存在前缀 #{prefix}"

    action in entry.actions ||
      raise "#{prefix} 未在权限目录声明动作 #{action}(现有:#{Enum.join(entry.actions, ",")})"

    prefix <> ":" <> action
  end

  @doc "建用户(角色+授权+公司)并签发真实登录 token。内部路径统一 authorize?: false。"
  def token!(permissions, opts \\ []) do
    user =
      User
      |> Ash.Changeset.for_create(:create, %{
        username: "mx_#{System.unique_integer([:positive])}",
        password: "secret123"
      })
      |> Ash.create!(authorize?: false)

    user =
      if opts[:super_admin] do
        user
        |> Ash.Changeset.for_update(:set_super_admin, %{})
        |> Ash.update!(authorize?: false)
      else
        user
      end

    # all_companies 无公开动作(仅初始化向导写),夹具走受信 force_change
    user =
      if opts[:all_companies] do
        user
        |> Ash.Changeset.for_update(:update, %{})
        |> Ash.Changeset.force_change_attribute(:all_companies, true)
        |> Ash.update!(authorize?: false)
      else
        user
      end

    if permissions != [] do
      role =
        Role
        |> Ash.Changeset.for_create(:create, %{
          code: "mx_#{System.unique_integer([:positive])}",
          name: "矩阵角色"
        })
        |> Ash.create!(authorize?: false)

      Enum.each(permissions, fn code ->
        RolePermission
        |> Ash.Changeset.for_create(:create, %{role_id: role.id, permission: code})
        |> Ash.create!(authorize?: false)
      end)

      UserRole
      |> Ash.Changeset.for_create(:create, %{user_id: user.id, role_id: role.id})
      |> Ash.create!(authorize?: false)
    end

    for company_id <- Keyword.get(opts, :companies, []) do
      UserCompany
      |> Ash.Changeset.for_create(:create, %{user_id: user.id, company_id: company_id})
      |> Ash.create!(authorize?: false)
    end

    SynieWeb.Auth.sign_token(user)
  end
end
