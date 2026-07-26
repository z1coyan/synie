defmodule CaptureMarketContract do
  @resources [
    {"basMarketInstruments", SynieCore.Base.MarketInstrument},
    {"basMarketPricePoints", SynieCore.Base.MarketPricePoint}
  ]

  def run(output_dir) do
    actor = %SynieCore.Authz.Actor{
      user_id: Ecto.UUID.generate(),
      super_admin: true
    }

    Enum.each(@resources, fn {name, module} ->
      meta =
        module
        |> SynieWeb.GridMeta.build(actor)
        |> camelize_keys()

      output = Path.join(output_dir, "#{name}.grid.json")
      File.mkdir_p!(Path.dirname(output))
      File.write!(output, Jason.encode!(meta, pretty: true) <> "\n")
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
    CaptureMarketContract.run(output_dir)

  _ ->
    raise "usage: mix run .scratch/migration/capture_market_contract.exs OUTPUT_DIR"
end
