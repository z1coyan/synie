defmodule SynieCore.Acc.OwnBankAccount do
  @moduledoc """
  校验所选银行账户:必须属于同一公司;`check_active: true` 时另要求账户启用
  (流水 create 用——停用账户不再录新流水;update 与导入模板不传,允许改存量归属)。

  `attribute:` 选项指定待校验的银行账户字段,默认 `:bank_account_id`(既有调用方零改动);
  承兑交易调拨的转入账户复用本校验时传 `attribute: :to_bank_account_id`。
  """

  use Ash.Resource.Validation

  @impl true
  def validate(changeset, opts, _context) do
    attribute = Keyword.get(opts, :attribute, :bank_account_id)

    case Ash.Changeset.get_attribute(changeset, attribute) do
      # allow_nil? false 的必填校验兜底
      nil -> :ok
      bank_account_id -> check(changeset, attribute, bank_account_id, opts)
    end
  end

  defp check(changeset, attribute, bank_account_id, opts) do
    company_id = Ash.Changeset.get_attribute(changeset, :company_id)

    case Ash.get(SynieCore.Acc.BankAccount, bank_account_id, authorize?: false) do
      {:ok, %{company_id: ^company_id} = account} ->
        if opts[:check_active] && not account.active do
          {:error, field: attribute, message: "停用账户不能新增流水"}
        else
          :ok
        end

      {:ok, _account} ->
        {:error, field: attribute, message: "银行账户必须属于同一公司"}

      {:error, _} ->
        {:error, field: attribute, message: "银行账户不存在"}
    end
  end
end
