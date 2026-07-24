defmodule SynieCore.Mfg.SyncParentDraft do
  @moduledoc """
  行与母单同步(通用 change):仅草稿母单可增删改行;create 时冗余 company_id。

  构建期快检 + before_action 对母单行加 FOR UPDATE 行锁权威复检,防母单状态
  在事务期间被并发改变。履约需求行(`DemandItem`)与生产入库行(`OutputItem`)
  共用,各自锁自己的母单(opts 指定母单资源与外键字段)。
  """

  use Ash.Resource.Change

  require Ash.Query

  @impl true
  def change(changeset, opts, _context) do
    parent = Keyword.fetch!(opts, :parent)
    parent_key = Keyword.fetch!(opts, :parent_key)
    not_found = Keyword.fetch!(opts, :not_found_message)
    not_draft = Keyword.fetch!(opts, :not_draft_message)

    changeset =
      case read_parent(parent, parent_id(changeset, parent_key)) do
        {:ok, %{status: :draft} = draft} ->
          if changeset.action_type == :create do
            Ash.Changeset.force_change_attribute(changeset, :company_id, draft.company_id)
          else
            changeset
          end

        {:ok, nil} ->
          Ash.Changeset.add_error(changeset, field: parent_key, message: not_found)

        {:ok, _other} ->
          Ash.Changeset.add_error(changeset, field: parent_key, message: not_draft)

        _ ->
          Ash.Changeset.add_error(changeset, field: parent_key, message: not_found)
      end

    Ash.Changeset.before_action(changeset, fn cs ->
      case lock_parent(parent, parent_id(cs, parent_key)) do
        {:ok, %{status: :draft}} ->
          cs

        {:ok, nil} ->
          Ash.Changeset.add_error(cs, field: parent_key, message: not_found)

        _ ->
          Ash.Changeset.add_error(cs, field: parent_key, message: not_draft)
      end
    end)
  end

  defp parent_id(changeset, parent_key),
    do: Ash.Changeset.get_attribute(changeset, parent_key) || Map.get(changeset.data, parent_key)

  defp read_parent(_parent, nil), do: {:ok, nil}

  defp read_parent(parent, id) do
    parent
    |> Ash.Query.filter(id == ^id)
    |> Ash.read_one(authorize?: false)
  end

  defp lock_parent(_parent, nil), do: {:ok, nil}

  defp lock_parent(parent, id) do
    parent
    |> Ash.Query.filter(id == ^id)
    |> Ash.Query.lock("FOR UPDATE")
    |> Ash.read_one(authorize?: false)
  end
end
