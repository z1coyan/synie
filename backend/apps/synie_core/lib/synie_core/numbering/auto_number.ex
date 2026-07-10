defmodule SynieCore.Numbering.AutoNumber do
  @moduledoc """
  通用自动编号 change:create 时目标属性留空则按绑定本资源的启用规则取号填充,
  已有值(手填)原样保留。挂上此 change 的资源自动进入编号规则页的资源下拉
  (GraphQL numberableResources 反射 create action changes)。

      change {SynieCore.Numbering.AutoNumber, attribute: :voucher_no}

  必须在构建期(change 主体)取号:Ash 的必填校验(require_values)在 for_create 末尾、
  before_action 之前执行,推迟到钩子里 allow_nil? false 的属性会先报必填。
  代价是后续校验/权限失败也会消耗序号——跳号可接受,序号允许有洞。
  """

  use Ash.Resource.Change

  @impl true
  def change(changeset, opts, _context) do
    attribute = Keyword.fetch!(opts, :attribute)

    if Ash.Changeset.get_attribute(changeset, attribute) do
      changeset
    else
      case SynieCore.Numbering.next(changeset) do
        {:ok, no} ->
          Ash.Changeset.force_change_attribute(changeset, attribute, no)

        {:error, :no_rule} ->
          Ash.Changeset.add_error(changeset,
            field: attribute,
            message: "未配置启用的编号规则,请填写编号,或在 系统管理→编号规则 配置"
          )

        {:error, message} ->
          Ash.Changeset.add_error(changeset, field: attribute, message: message)
      end
    end
  end
end
