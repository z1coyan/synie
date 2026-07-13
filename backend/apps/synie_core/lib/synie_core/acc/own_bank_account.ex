defmodule SynieCore.Acc.OwnBankAccount do
  @moduledoc """
  校验所选银行账户:必须属于同一公司;`check_active: true` 时另要求账户启用
  (流水 create 用——停用账户不再录新流水;update 与导入模板不传,允许改存量归属)。
  """

  use Ash.Resource.Validation

  @impl true
  def validate(changeset, opts, _context) do
    case Ash.Changeset.get_attribute(changeset, :bank_account_id) do
      # allow_nil? false 的必填校验兜底
      nil -> :ok
      bank_account_id -> check(changeset, bank_account_id, opts)
    end
  end

  defp check(changeset, bank_account_id, opts) do
    company_id = Ash.Changeset.get_attribute(changeset, :company_id)

    case Ash.get(SynieCore.Acc.BankAccount, bank_account_id, authorize?: false) do
      {:ok, %{company_id: ^company_id} = account} ->
        if opts[:check_active] && not account.active do
          {:error, field: :bank_account_id, message: "停用账户不能新增流水"}
        else
          :ok
        end

      {:ok, _account} ->
        {:error, field: :bank_account_id, message: "银行账户必须属于同一公司"}

      {:error, _} ->
        {:error, field: :bank_account_id, message: "银行账户不存在"}
    end
  end
end
