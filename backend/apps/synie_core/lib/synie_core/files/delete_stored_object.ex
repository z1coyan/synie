defmodule SynieCore.Files.DeleteStoredObject do
  @moduledoc """
  sys_file 行删除、事务提交后,尽力清理物理对象。
  清理失败只告警不报错:行已删,残留孤儿对象无害且可事后扫。
  """

  use Ash.Resource.Change

  require Logger

  @impl true
  def change(changeset, _opts, _ctx) do
    Ash.Changeset.after_transaction(changeset, fn _changeset, result ->
      case result do
        {:ok, record} ->
          case SynieCore.Storage.delete(record.storage, record.key) do
            :ok ->
              :ok

            {:error, reason} ->
              Logger.warning("清理存储对象失败 #{record.storage}/#{record.key}: #{inspect(reason)}")
          end

        _ ->
          :noop
      end

      result
    end)
  end
end
