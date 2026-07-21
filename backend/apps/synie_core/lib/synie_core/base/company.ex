defmodule SynieCore.Base.Company do
  @moduledoc "公司(ERPNext 式多公司,单库),对应 `bas_company` 表,树形结构支持集团/合并视角。本币(base_currency)必填,是该记账主体单据双币换算的目标口径。"

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    fragments: [SynieCore.Audit.Fragment]

  postgres do
    table "bas_company"
    repo SynieCore.Repo
  end

  graphql do
    type :bas_company
  end

  policies do
    bypass actor_attribute_equals(:super_admin, true) do
      authorize_if always()
    end

    policy always() do
      authorize_if SynieCore.Authz.Checks.HasPermission
    end
  end

  def permission_prefix, do: "base.company"
  def permission_label, do: "公司"
  def permission_actions, do: ~w(create read update delete)

  actions do
    defaults [:read]

    create :create do
      accept [:code, :name, :short_name, :parent_id, :base_currency_id]
    end

    update :update do
      accept [:name, :short_name, :parent_id, :base_currency_id]
      require_atomic? false

      # 只挡自引用(parent_id 设为自身 id 会让树遍历死循环);两节点以上成环检测留跟进,
      # 需要额外查库才能判断,权衡后本轮先堵最常见的误操作路径(试点页 UI 正常可触发)
      validate fn changeset, _context ->
        parent_id = Ash.Changeset.get_attribute(changeset, :parent_id)

        if parent_id && parent_id == changeset.data.id do
          {:error, field: :parent_id, message: "上级公司不能选择自身"}
        else
          :ok
        end
      end
    end

    destroy :destroy do
      primary? true
      require_atomic? false
    end
  end

  attributes do
    uuid_primary_key :id

    # 公司编号:手动输入,固定两位英文字母,创建后不可改
    attribute :code, :string do
      allow_nil? false
      public? true
      constraints match: ~r/^[A-Za-z]{2}$/
      description "公司编号"
    end

    attribute :name, :string do
      allow_nil? false
      public? true
      constraints max_length: 128
      description "公司名称"
    end

    attribute :short_name, :string do
      allow_nil? false
      public? true
      constraints max_length: 32
      description "公司简称"
    end

    create_timestamp :inserted_at
    update_timestamp :updated_at
  end

  relationships do
    belongs_to :parent, __MODULE__ do
      public? true
      attribute_public? true
      attribute_writable? true
      description "上级公司"
    end

    # 本币:记账主体的记账货币,单据双币换算的目标口径(ADR 2026-07-17-sales-order-currency);
    # 迁移已回填存量公司为 CNY
    belongs_to :base_currency, SynieCore.Base.Currency do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "本币"
    end
  end

  identities do
    identity :unique_code, [:code]
  end
end
