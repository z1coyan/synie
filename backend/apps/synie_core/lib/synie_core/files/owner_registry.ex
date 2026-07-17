defmodule SynieCore.Files.OwnerRegistry do
  @moduledoc "附件宿主 owner_type(graphql type 名)→ 资源模块的显式白名单(fail-closed)。"

  @owners %{
    "sal_customer" => SynieCore.Sales.Customer,
    "sal_order_item" => SynieCore.Sales.OrderItem,
    "pur_supplier" => SynieCore.Purchase.Supplier,
    "hr_employee" => SynieCore.Hr.Employee,
    "inv_material" => SynieCore.Inv.Material,
    "acc_gl_journal" => SynieCore.Acc.GlJournal,
    "acc_bank_account" => SynieCore.Acc.BankAccount,
    "acc_bank_transaction" => SynieCore.Acc.BankTransaction,
    "acc_vat_invoice" => SynieCore.Acc.VatInvoice,
    "acc_bill" => SynieCore.Acc.Bill,
    "acc_bill_transaction" => SynieCore.Acc.BillTransaction
  }

  @spec resolve(String.t()) :: {:ok, module()} | :error
  def resolve(owner_type), do: Map.fetch(@owners, owner_type)

  @spec owner_types() :: [String.t()]
  def owner_types, do: Map.keys(@owners)
end
