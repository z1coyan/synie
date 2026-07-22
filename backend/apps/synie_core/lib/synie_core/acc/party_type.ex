defmodule SynieCore.Acc.PartyType do
  @moduledoc "往来对手类型:供应商/客户/内部公司/员工。凭证行、总账分录与发票共用。"

  use Ash.Type.Enum,
    values: [supplier: "供应商", customer: "客户", company: "内部公司", employee: "员工"]

  def graphql_type(_), do: :acc_party_type

  @doc "类型 → 主数据资源映射(存在性校验与 GridMeta 多态 fk 反射共用)"
  def party_resources do
    %{
      supplier: SynieCore.Purchase.Supplier,
      customer: SynieCore.Sales.Customer,
      company: SynieCore.Base.Company,
      employee: SynieCore.Hr.Employee
    }
  end
end
