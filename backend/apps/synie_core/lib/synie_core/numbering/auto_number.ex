defmodule SynieCore.Numbering.AutoNumber do
  @moduledoc """
  通用自动编号 change:create 时目标属性留空则按规则取号填充,已有值(手填)原样保留。

      change {SynieCore.Numbering.AutoNumber,
              rule: "acc.gl_journal", attribute: :voucher_no,
              date_attribute: :date, company_attribute: :company_id}

  必须在构建期(change 主体)取号:Ash 的必填校验(require_values)在 for_create 末尾、
  before_action 之前执行,推迟到钩子里 allow_nil? false 的属性会先报必填。
  代价是后续校验/权限失败也会消耗序号——跳号可接受,序号允许有洞。
  日期属性缺失时静默跳过(交给该属性自身的必填校验报错)。
  """

  use Ash.Resource.Change

  @impl true
  def change(changeset, opts, _context) do
    attribute = Keyword.fetch!(opts, :attribute)
    date = Ash.Changeset.get_attribute(changeset, Keyword.fetch!(opts, :date_attribute))

    if Ash.Changeset.get_attribute(changeset, attribute) || is_nil(date) do
      changeset
    else
      generate(changeset, attribute, date, opts)
    end
  end

  defp generate(changeset, attribute, date, opts) do
    company_id =
      Ash.Changeset.get_attribute(changeset, Keyword.fetch!(opts, :company_attribute))

    case SynieCore.Numbering.next(Keyword.fetch!(opts, :rule), company_id: company_id, date: date) do
      {:ok, no} ->
        Ash.Changeset.force_change_attribute(changeset, attribute, no)

      {:error, :no_rule} ->
        Ash.Changeset.add_error(changeset,
          field: attribute,
          message: "未配置启用的编号规则,请填写编号,或在 系统管理→编号规则 配置 #{opts[:rule]}"
        )

      {:error, message} ->
        Ash.Changeset.add_error(changeset, field: attribute, message: message)
    end
  end
end
