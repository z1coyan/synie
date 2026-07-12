defmodule SynieCore.Files.OwnerRegistry do
  @moduledoc "附件宿主 owner_type(graphql type 名)→ 资源模块的显式白名单(fail-closed)。"

  @owners %{
    "sal_customer" => SynieCore.Sales.Customer,
    "pur_supplier" => SynieCore.Purchase.Supplier,
    "acc_gl_journal" => SynieCore.Acc.GlJournal,
    "acc_vat_invoice" => SynieCore.Acc.VatInvoice
  }

  @spec resolve(String.t()) :: {:ok, module()} | :error
  def resolve(owner_type), do: Map.fetch(@owners, owner_type)

  @spec owner_types() :: [String.t()]
  def owner_types, do: Map.keys(@owners)
end
