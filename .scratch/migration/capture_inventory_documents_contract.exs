defmodule CaptureInventoryDocumentsContract do
  @resources [
    {"invStockEntries", SynieCore.Inv.StockEntry},
    {"invStockDocs", SynieCore.Inv.StockDoc},
    {"invStockDocItems", SynieCore.Inv.StockDocItem},
    {"invStockTransfers", SynieCore.Inv.StockTransfer},
    {"invStockTransferItems", SynieCore.Inv.StockTransferItem},
    {"invStockCounts", SynieCore.Inv.StockCount},
    {"invStockCountItems", SynieCore.Inv.StockCountItem}
  ]

  def run(output_dir) do
    actors = [
      {"superadmin",
       %SynieCore.Authz.Actor{
         user_id: Ecto.UUID.generate(),
         super_admin: true
       }},
      {"read-only",
       %SynieCore.Authz.Actor{
         user_id: Ecto.UUID.generate(),
         permissions:
           MapSet.new([
             "inv.stock_entry:read",
             "inv.stock_doc:read",
             "inv.stock_transfer:read",
             "inv.stock_count:read"
           ])
       }}
    ]

    Enum.each(@resources, fn {name, module} ->
      Enum.each(actors, fn {actor_name, actor} ->
        meta =
          module
          |> SynieWeb.GridMeta.build(actor)
          |> camelize_keys()

        output = Path.join(output_dir, "#{name}.#{actor_name}.grid.json")
        File.mkdir_p!(Path.dirname(output))
        File.write!(output, Jason.encode!(meta, pretty: true) <> "\n")
      end)
    end)
  end

  defp camelize_keys(value) when is_list(value), do: Enum.map(value, &camelize_keys/1)

  defp camelize_keys(value) when is_map(value) do
    Map.new(value, fn {key, item} ->
      key =
        key
        |> to_string()
        |> Absinthe.Utils.camelize(lower: true)

      {key, camelize_keys(item)}
    end)
  end

  defp camelize_keys(value), do: value
end

case System.argv() do
  [output_dir] ->
    CaptureInventoryDocumentsContract.run(output_dir)

  _ ->
    raise """
    usage:
      mix run .scratch/migration/capture_inventory_documents_contract.exs OUTPUT_DIR
    """
end
