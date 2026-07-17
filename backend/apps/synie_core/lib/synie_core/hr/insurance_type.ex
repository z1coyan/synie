defmodule SynieCore.Hr.InsuranceType do
  @moduledoc """
  参保类型:员工参加的社保/商保原子险种,员工档案上多选任意组合。

  「五险一金」「三险」不是系统概念,只是勾选组合;商保不区分保司与保单信息。
  原子化即为将来社保扣款联动的预留:扣款引擎按险种读取,无需改档案结构(见 ADR)。
  """

  use Ash.Type.Enum,
    values: [
      social_injury: "社保工伤",
      social_unemployment: "社保失业",
      social_medical: "社保医疗",
      social_pension: "社保养老",
      social_maternity: "社保生育",
      housing_fund: "公积金",
      commercial_injury: "商保工伤",
      commercial_medical: "商保医疗"
    ]

  def graphql_type(_), do: :hr_insurance_type
end
