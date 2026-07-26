defmodule CapturePrintContract do
  @meta_query """
  query ($resource: String!) {
    gridMeta(resource: $resource) {
      columns {
        name
        type
        label
        sortable
        filterable
        enumOptions { value label }
        ref {
          resource
          relation
          labelField
          discriminator
          discriminatorType
          variants { value resource labelField label }
        }
      }
      capabilities
      extendedActions { key label scope mutation isDanger }
      destroyMutation
    }
  }
  """

  def run(catalog_output, meta_output) do
    actor = %SynieCore.Authz.Actor{user_id: Ecto.UUID.generate(), super_admin: true}

    catalog =
      SynieCore.Printing.FieldCatalog.resources()
      |> Enum.map(fn resource ->
        module = SynieCore.Printing.FieldCatalog.module_for(resource)

        definition =
          resource
          |> SynieCore.Printing.FieldCatalog.get()
          |> Map.update!(:loops, fn loops ->
            Enum.map(loops, fn loop ->
              relationship =
                Ash.Resource.Info.relationship(module, String.to_existing_atom(loop.name))

              nested_loops =
                relationship.destination
                |> SynieCore.Printing.FieldCatalog.many_relationships()
                |> Enum.map(&to_string(&1.name))
                |> Enum.sort()

              Map.put(loop, :nestedLoops, nested_loops)
            end)
          end)

        Map.put(definition, :resource, resource)
      end)

    {:ok, %{data: %{"gridMeta" => meta}}} =
      Absinthe.run(@meta_query, SynieWeb.Schema,
        context: %{actor: actor},
        variables: %{"resource" => "sysPrintTemplates"}
      )

    write_json(catalog_output, catalog)
    write_json(meta_output, meta)
  end

  defp write_json(path, value) do
    File.mkdir_p!(Path.dirname(path))
    File.write!(path, Jason.encode!(value, pretty: true) <> "\n")
  end
end

case System.argv() do
  [catalog_output, meta_output] ->
    CapturePrintContract.run(catalog_output, meta_output)

  _ ->
    raise "usage: mix run .scratch/migration/capture_print_contract.exs CATALOG META"
end
