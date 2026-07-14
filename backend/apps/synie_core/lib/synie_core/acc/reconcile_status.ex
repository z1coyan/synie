defmodule SynieCore.Acc.ReconcileStatus do
  @moduledoc "银行流水对账状态:未对账/部分对账/已对账。持久化派生列,由对账记录增删在锁内刷新。"

  use Ash.Type.Enum, values: [unreconciled: "未对账", partial: "部分对账", reconciled: "已对账"]

  def graphql_type(_), do: :acc_reconcile_status
end
