defmodule SynieCore.Acc.PartyType do
  @moduledoc "往来对手类型:供应商/客户。凭证行与总账分录共用。"

  use Ash.Type.Enum, values: [supplier: "供应商", customer: "客户"]

  def graphql_type(_), do: :acc_party_type
end
