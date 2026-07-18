defmodule SynieCore.Setup do
  @moduledoc """
  初始化向导(Setup)门面:全新部署首启时的一次性业务初始化。

  门控:`sys_setting.setup_completed_at` 空 = 未初始化,向导开放;落库后相关接口永久关闭。
  分层:环境层初始化(存储接入、编号规则)仍由 seeds 承担,这里只管业务初始化——
  首个超级管理员、常用货币预置、首选语言与完成落旗。公司创建/科目表初始化等中间步骤
  由前端向导直接调既有 mutation(超管身份),不在此门面内。

  全部为受信内部路径(`authorize?: false`);GraphQL schema 负责按接口要求校验 actor。
  """

  require Ash.Query

  alias SynieCore.Accounts.User
  alias SynieCore.Authz.Actor
  alias SynieCore.Base.Currency
  alias SynieCore.Repo
  alias SynieCore.Sys.Setting

  @languages ["zh-CN", "en-US"]

  # 常用货币预置清单:向导公司步进入时按 iso_code 幂等补齐(老环境不经向导,不强塞)
  @common_currencies [
    %{name: "人民币", iso_code: "CNY", symbol: "￥"},
    %{name: "美元", iso_code: "USD", symbol: "$"},
    %{name: "欧元", iso_code: "EUR", symbol: "€"},
    %{name: "日元", iso_code: "JPY", symbol: "¥"},
    %{name: "港币", iso_code: "HKD", symbol: "HK$"},
    %{name: "新台币", iso_code: "TWD", symbol: "NT$"},
    %{name: "英镑", iso_code: "GBP", symbol: "£"},
    %{name: "韩元", iso_code: "KRW", symbol: "₩"},
    %{name: "新加坡元", iso_code: "SGD", symbol: "S$"},
    %{name: "澳大利亚元", iso_code: "AUD", symbol: "A$"},
    %{name: "加拿大元", iso_code: "CAD", symbol: "C$"},
    %{name: "瑞士法郎", iso_code: "CHF", symbol: "CHF"},
    %{name: "澳门元", iso_code: "MOP", symbol: "MOP$"},
    %{name: "泰铢", iso_code: "THB", symbol: "฿"},
    %{name: "马来西亚林吉特", iso_code: "MYR", symbol: "RM"},
    %{name: "印尼盾", iso_code: "IDR", symbol: "Rp"},
    %{name: "越南盾", iso_code: "VND", symbol: "₫"},
    %{name: "菲律宾比索", iso_code: "PHP", symbol: "₱"},
    %{name: "印度卢比", iso_code: "INR", symbol: "₹"},
    %{name: "俄罗斯卢布", iso_code: "RUB", symbol: "₽"}
  ]

  @doc "向导状态:是否已初始化、库中是否已有用户(决定向导从哪步续做)。"
  @spec status() :: %{initialized: boolean(), has_users: boolean()}
  def status do
    %{initialized: initialized?(), has_users: users_exist?()}
  end

  @doc "系统是否已完成初始化(完成旗标已落)。"
  @spec initialized?() :: boolean()
  def initialized? do
    case Setting.get() do
      %{setup_completed_at: %DateTime{}} -> true
      _ -> false
    end
  end

  @doc """
  创建首个用户并打超级管理员旗标(返回可用于签发登录态的用户)。
  仅在「未初始化 且 库中无用户」时可用;两条件之外即拒绝,天然幂等。
  """
  @spec create_first_user(map()) :: {:ok, User.t()} | {:error, term()}
  def create_first_user(%{username: _, password: _} = attrs) do
    cond do
      initialized?() ->
        {:error, "系统已完成初始化"}

      users_exist?() ->
        {:error, "已存在用户,请直接登录"}

      true ->
        Repo.transaction(fn ->
          {user, n1} =
            User
            |> Ash.Changeset.for_create(:create, Map.take(attrs, [:username, :name, :password]))
            |> Ash.create!(authorize?: false, return_notifications?: true)

          {user, n2} =
            user
            |> Ash.Changeset.for_update(:set_super_admin, %{})
            |> Ash.update!(authorize?: false, return_notifications?: true)

          {user, n1 ++ n2}
        end)
        |> case do
          # 通知在提交后补发(事务内直发会把未提交事件投递出去)
          {:ok, {user, notifications}} ->
            Ash.Notifier.notify(notifications)
            {:ok, user}

          {:error, error} ->
            {:error, error}
        end
    end
  rescue
    e -> {:error, e}
  end

  @doc "预置常用货币(按 iso_code 幂等,返回本次新建条数);仅未初始化时可用。"
  @spec seed_common_currencies() :: {:ok, non_neg_integer()} | {:error, term()}
  def seed_common_currencies do
    if initialized?() do
      {:error, "系统已完成初始化"}
    else
      existing =
        Currency
        |> Ash.Query.filter(iso_code in ^Enum.map(@common_currencies, & &1.iso_code))
        |> Ash.read!(authorize?: false)
        |> MapSet.new(& &1.iso_code)

      created =
        @common_currencies
        |> Enum.reject(&(&1.iso_code in existing))
        |> Enum.map(fn attrs ->
          Currency
          |> Ash.Changeset.for_create(:create, attrs)
          |> Ash.create!(authorize?: false)
        end)

      {:ok, length(created)}
    end
  end

  @doc """
  完成初始化:写入当前用户的首选语言并落完成旗标(同事务)。
  落旗后 setup 各接口随之关闭;仅未初始化时可用。
  """
  @spec complete(Actor.t(), String.t()) :: :ok | {:error, term()}
  def complete(%Actor{user_id: user_id} = actor, language) do
    cond do
      initialized?() ->
        {:error, "系统已完成初始化"}

      language not in @languages ->
        {:error, "不支持的语言"}

      true ->
        Repo.transaction(fn ->
          user = Ash.get!(User, user_id, authorize?: false)

          {_user, n1} =
            user
            |> Ash.Changeset.for_update(:update, %{})
            |> Ash.Changeset.force_change_attribute(:preferred_language, language)
            |> Ash.update!(authorize?: false, actor: actor, return_notifications?: true)

          {setting, n2} =
            Setting.get()
            |> Ash.Changeset.for_update(:update, %{})
            |> Ash.Changeset.force_change_attribute(:setup_completed_at, DateTime.utc_now())
            |> Ash.update!(authorize?: false, actor: actor, return_notifications?: true)

          {setting, n1 ++ n2}
        end)
        |> case do
          {:ok, {_setting, notifications}} ->
            Ash.Notifier.notify(notifications)
            :ok

          {:error, error} ->
            {:error, error}
        end
    end
  rescue
    e -> {:error, e}
  end

  defp users_exist? do
    User |> Ash.exists?(authorize?: false)
  end
end
