defmodule SynieCore.Acc.PartyType do
  @moduledoc "往来对手类型:供应商/客户。凭证行与总账分录共用。"

  use Ash.Type.Enum, values: [supplier: "供应商", customer: "客户"]

  def graphql_type(_), do: :acc_party_type

  @doc "类型 → 主数据资源映射(凭证行存在性校验与 GridMeta 多态 fk 反射共用)"
  def party_resources do
    %{supplier: SynieCore.Purchase.Supplier, customer: SynieCore.Sales.Customer}
  end
end
