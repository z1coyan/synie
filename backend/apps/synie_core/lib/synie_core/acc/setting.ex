defmodule SynieCore.Acc.Setting do
  @moduledoc """
  财务设置,对应 `acc_setting` 单行表:财务域全局配置(非公司维度)统一加字段进这张表,
  不另建配置表。行由迁移 seed、恒存在——不开放 create/destroy,只有 update。
  当前字段:阿里云 OCR 凭证(发票/承兑识别用,见 `SynieCore.Ocr`)。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    fragments: [SynieCore.Audit.Fragment]

  postgres do
    table "acc_setting"
    repo SynieCore.Repo
  end

  graphql do
    type :acc_setting
  end

  policies do
    bypass actor_attribute_equals(:super_admin, true) do
      authorize_if always()
    end

    policy action([:read, :update]) do
      authorize_if SynieCore.Authz.Checks.HasPermission
    end

    # 配置态布尔只用于前端 OCR 按钮防呆,不含凭证内容,登录即可读
    policy action(:ocr_configured) do
      authorize_if actor_present()
    end
  end

  def permission_prefix, do: "acc.setting"
  def permission_actions, do: ~w(read update)

  actions do
    read :read do
      primary? true
    end

    update :update do
      accept [:ocr_access_key_id]

      # 密钥只写不回读(public? false 不进 accept/GraphQL),经 argument 写入;nil/空串 = 不修改
      argument :ocr_access_key_secret, :string

      change fn changeset, _context ->
        case Ash.Changeset.get_argument(changeset, :ocr_access_key_secret) do
          nil ->
            changeset

          "" ->
            changeset

          secret ->
            Ash.Changeset.force_change_attribute(changeset, :ocr_access_key_secret, secret)
        end
      end

      require_atomic? false
    end

    action :ocr_configured, :boolean do
      description "阿里云 OCR 凭证是否已配置(供前端 OCR 按钮防呆)"

      run fn _input, _context ->
        # DSL run 闭包内 alias 不生效(同 bank_reconciliation :remaining 先例),全限定
        configured =
          case SynieCore.Acc.Setting.get() do
            %{ocr_access_key_id: ak, ocr_access_key_secret: sk} ->
              is_binary(ak) and String.trim(ak) != "" and
                is_binary(sk) and String.trim(sk) != ""

            nil ->
              false
          end

        {:ok, configured}
      end
    end
  end

  attributes do
    uuid_primary_key :id

    attribute :ocr_access_key_id, :string do
      public? true
      constraints max_length: 128
      description "阿里云 OCR AccessKey ID"
    end

    attribute :ocr_access_key_secret, :string do
      public? false
      sensitive? true
      constraints max_length: 128
      description "阿里云 OCR AccessKey Secret"
    end

    create_timestamp :inserted_at, public?: true, description: "创建时间"
    update_timestamp :updated_at, public?: true, description: "更新时间"
  end

  @doc "取单行配置(受信内部读;迁移 seed 保证存在,nil 仅见于异常环境)。"
  @spec get() :: %__MODULE__{} | nil
  def get do
    __MODULE__ |> Ash.read!(authorize?: false) |> List.first()
  end
end
