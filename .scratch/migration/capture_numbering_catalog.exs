defmodule CaptureNumberingCatalog do
  @skip ~w(id insertedAt updatedAt)

  def run(output) do
    actor = %SynieCore.Authz.Actor{user_id: Ecto.UUID.generate(), super_admin: true}

    catalog =
      SynieWeb.GridMeta.numberable_resources()
      |> Enum.map(&definition(&1, actor))
      |> Enum.sort_by(& &1.prefix)

    File.mkdir_p!(Path.dirname(output))
    File.write!(output, Jason.encode!(catalog, pretty: true) <> "\n")
  end

  defp definition(%{prefix: prefix, grid: grid}, actor) do
    module = Map.fetch!(SynieWeb.GridMeta.resources(), grid)
    {:ok, meta} = SynieWeb.GridMeta.resolve(grid, actor)

    fields =
      meta.columns
      |> Enum.reject(&(&1.name in @skip))
      |> Enum.flat_map(&field_definitions(module, &1, actor))

    %{prefix: prefix, grid: grid, fields: fields}
  end

  defp field_definitions(module, %{ref: %{resource: grid, relation: relation}} = column, actor)
       when is_binary(grid) and is_binary(relation) do
    relationship =
      Ash.Resource.Info.relationship(
        module,
        relation |> Macro.underscore() |> String.to_existing_atom()
      )

    destination = relationship.destination
    {:ok, target_meta} = SynieWeb.GridMeta.resolve(grid, actor)

    target_meta.columns
    |> Enum.reject(&(&1.name in @skip or &1.type == "fk"))
    |> Enum.flat_map(fn target ->
      attribute =
        Ash.Resource.Info.attribute(
          destination,
          target.name |> Macro.underscore() |> String.to_existing_atom()
        )

      if is_nil(attribute) do
        []
      else
        [
          %{
            path: "#{Macro.underscore(relation)}.#{Macro.underscore(target.name)}",
            label: "#{column.label}·#{target.label}",
            type: target.type,
            sourceField: attribute_source(module, relationship.source_attribute),
            lookup: %{
              table: AshPostgres.DataLayer.Info.table(destination),
              valueColumn: to_string(attribute.source || attribute.name)
            }
          }
        ]
      end
    end)
  end

  defp field_definitions(module, column, _actor) do
    name = Macro.underscore(column.name)
    attribute = Ash.Resource.Info.attribute(module, String.to_existing_atom(name))

    if is_nil(attribute) do
      []
    else
      [
        %{
          path: name,
          label: column.label,
          type: column.type,
          sourceField: to_string(attribute.source || attribute.name)
        }
      ]
    end
  end

  defp attribute_source(module, name) do
    attribute = Ash.Resource.Info.attribute(module, name)
    to_string(attribute.source || attribute.name)
  end
end

case System.argv() do
  [output] -> CaptureNumberingCatalog.run(output)
  _ -> raise "usage: mix run .scratch/migration/capture_numbering_catalog.exs OUTPUT"
end
