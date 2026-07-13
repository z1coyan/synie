defmodule SynieCore.Acc.PartyExists do
  @moduledoc "对手校验:与类型同空同有;按类型查对应主数据表确认存在(多态引用无真外键)。凭证行与发票共用。"

  use Ash.Resource.Validation

  @impl true
  def validate(changeset, _opts, _context) do
    party_type = Ash.Changeset.get_attribute(changeset, :party_type)
    party_id = Ash.Changeset.get_attribute(changeset, :party_id)

    cond do
      is_nil(party_type) and is_nil(party_id) ->
        :ok

      is_nil(party_type) or is_nil(party_id) ->
        {:error, field: :party_id, message: "对手类型与对手必须同时填写"}

      true ->
        case Ash.get(
               Map.fetch!(SynieCore.Acc.PartyType.party_resources(), party_type),
               party_id,
               authorize?: false
             ) do
          {:ok, _} -> :ok
          {:error, _} -> {:error, field: :party_id, message: "对手不存在"}
        end
    end
  end
end
