defmodule SynieCore.Mfg.Bom.NoRoutes do
  @moduledoc "从工艺模板带入路线的前提:本 BOM 尚无工艺路线行(已有则拒,避免混入两套路线)。"

  use Ash.Resource.Validation

  require Ash.Query

  @impl true
  def validate(changeset, _opts, _context) do
    exists? =
      SynieCore.Mfg.BomRoute
      |> Ash.Query.filter(bom_id == ^changeset.data.id)
      |> Ash.exists?(authorize?: false)

    if exists? do
      {:error, message: "已有工艺路线,不能从模板带入"}
    else
      :ok
    end
  end
end

defmodule SynieCore.Mfg.Bom.TemplateExists do
  @moduledoc "校验带入的模板存在(构建期预检,友好报错;DB 外键兜底)。"

  use Ash.Resource.Validation

  @impl true
  def validate(changeset, _opts, _context) do
    template_id = Ash.Changeset.get_argument(changeset, :template_id)

    case Ash.get(SynieCore.Mfg.ProcessTemplate, template_id, authorize?: false) do
      {:ok, _} -> :ok
      {:error, _} -> {:error, field: :template_id, message: "工艺模板不存在"}
    end
  end
end

defmodule SynieCore.Mfg.Bom do
  @moduledoc """
  BOM(物料清单),对应 `mfg_bom` 表。挂在物料上的单层配方主数据:一物料至多一张、
  以物料为唯一键、无独立编号、跟随物料全局共享(不分公司);单份可改可删,
  历史靠审计日志,版本管理待有下游引用时再议(见 BOM 模块 ADR 2026-07-22)。

  子表:配料行 `BomComponent`(子物料+单位+单位净用量+可空损耗率)、
  工艺路线行 `BomRoute`(工序引用+工艺要求+外协标记)、副产品行 `BomByproduct`
  (联产出物料+单位产出量)。行是独立资源,前端做 diff 持久化,不走 manage_relationship。

  `apply_route_template`:选工艺模板复制带入为本 BOM 私行(按 seq 复制模板行),
  仅当本 BOM 尚无路线行时允许;复制后模板再改不影响已建 BOM(快照语义)。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    fragments: [SynieCore.Audit.Fragment]

  require Ash.Query

  postgres do
    table "mfg_bom"
    repo SynieCore.Repo

    references do
      # BOM 以物料为唯一键,有 BOM 的物料不可删(DB 兜底)
      reference :material, on_delete: :restrict
    end
  end

  graphql do
    type :mfg_bom
  end

  policies do
    bypass actor_attribute_equals(:super_admin, true) do
      authorize_if always()
    end

    # 从模板带入路线是编辑能力的衍生:复用 update 码,不设独立权限点(同工资单 refresh 先例)
    policy action(:apply_route_template) do
      authorize_if {SynieCore.Authz.Checks.HasPermission, as: "update"}
    end

    policy action([:read, :create, :update, :destroy]) do
      authorize_if SynieCore.Authz.Checks.HasPermission
    end
  end

  def permission_prefix, do: "mfg.bom"
  def permission_label, do: "BOM"
  def permission_actions, do: ~w(create read update delete)

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
      accept [:material_id, :note]
    end

    update :update do
      # 不接受 :material_id:BOM 以物料为唯一键,创建后不换物料(换物料=删旧建新)
      accept [:note]
      require_atomic? false
    end

    destroy :destroy do
      # 配料/路线/副产品行随 BOM 级联删(DB reference on_delete: :delete)
      primary? true
      require_atomic? false
    end

    # 从工艺模板复制带入工艺路线:仅当本 BOM 尚无路线行;复制为 BOM 私行后
    # 与模板脱钩(快照语义)。复制在 after_action 同事务内建行,任一行失败整体回滚
    update :apply_route_template do
      accept []
      require_atomic? false

      argument :template_id, :uuid, allow_nil?: false

      validate {SynieCore.Mfg.Bom.NoRoutes, []}
      validate {SynieCore.Mfg.Bom.TemplateExists, []}

      change fn changeset, _context ->
        Ash.Changeset.after_action(changeset, fn _cs, bom ->
          case __MODULE__.copy_template_routes(
                 bom,
                 Ash.Changeset.get_argument(changeset, :template_id)
               ) do
            :ok -> {:ok, bom}
            {:error, error} -> {:error, error}
          end
        end)
      end
    end
  end

  attributes do
    uuid_primary_key :id

    attribute :note, :string do
      public? true
      constraints max_length: 255
      description "备注"
    end

    create_timestamp :inserted_at, public?: true, description: "创建时间"
    update_timestamp :updated_at, public?: true, description: "更新时间"
  end

  relationships do
    belongs_to :material, SynieCore.Inv.Material do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "物料"
    end

    has_many :components, SynieCore.Mfg.BomComponent do
      destination_attribute :bom_id
    end

    has_many :routes, SynieCore.Mfg.BomRoute do
      destination_attribute :bom_id
    end

    has_many :byproducts, SynieCore.Mfg.BomByproduct do
      destination_attribute :bom_id
    end
  end

  identities do
    identity :unique_material, [:material_id], message: "该物料已存在 BOM"
  end

  @doc false
  # 模板行按 seq 复制为 BOM 路线私行(行各项校验走 BomRoute create);任一行失败整体回滚
  def copy_template_routes(bom, template_id) do
    template_id
    |> items_of_template()
    |> Enum.reduce_while(:ok, fn item, :ok ->
      case SynieCore.Mfg.BomRoute
           |> Ash.Changeset.for_create(:create, %{
             bom_id: bom.id,
             operation_id: item.operation_id,
             seq: item.seq,
             requirement: item.requirement,
             is_outsourced: item.is_outsourced
           })
           |> Ash.create(authorize?: false) do
        {:ok, _route} -> {:cont, :ok}
        {:error, error} -> {:halt, {:error, error}}
      end
    end)
  end

  defp items_of_template(template_id) do
    SynieCore.Mfg.ProcessTemplateItem
    |> Ash.Query.filter(template_id == ^template_id)
    |> Ash.Query.sort(seq: :asc)
    |> Ash.read!(authorize?: false)
  end
end
