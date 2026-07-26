defmodule CaptureSystemContract do
  @resources [
    {"sysAuditLogs", SynieCore.Audit.Log},
    {"sysTodos", SynieCore.Sys.Todo},
    {"sysTodoStates", SynieCore.Sys.TodoState}
  ]

  @graphql_fields %{
    "query" => ["sysAuditLogs", "sysTodos", "sysTodoUnreadCount"],
    "mutation" => ["markReadSysTodo", "dismissSysTodo"]
  }

  @introspection """
  query {
    query: __type(name: "RootQueryType") {
      fields {
        name
        description
        args {
          name
          defaultValue
          type { ...TypeRef }
        }
        type { ...TypeRef }
      }
    }
    mutation: __type(name: "RootMutationType") {
      fields {
        name
        description
        args {
          name
          defaultValue
          type { ...TypeRef }
        }
        type { ...TypeRef }
      }
    }
    sysAuditLog: __type(name: "SysAuditLog") {
      name
      fields {
        name
        description
        type { ...TypeRef }
      }
    }
    sysTodo: __type(name: "SysTodo") {
      name
      fields {
        name
        description
        type { ...TypeRef }
      }
    }
    sysTodoState: __type(name: "SysTodoState") {
      name
      fields {
        name
        description
        type { ...TypeRef }
      }
    }
  }

  fragment TypeRef on __Type {
    kind
    name
    ofType {
      kind
      name
      ofType {
        kind
        name
        ofType {
          kind
          name
        }
      }
    }
  }
  """

  def run(output_dir) do
    File.mkdir_p!(output_dir)

    actors = [
      {"superadmin",
       %SynieCore.Authz.Actor{
         user_id: Ecto.UUID.generate(),
         super_admin: true
       }},
      {"read-only",
       %SynieCore.Authz.Actor{
         user_id: Ecto.UUID.generate(),
         permissions: MapSet.new(["sys.audit_log:read", "acc.vat_invoice:create"])
       }}
    ]

    Enum.each(@resources, fn {name, module} ->
      Enum.each(actors, fn {actor_name, actor} ->
        capture_grid_meta(output_dir, name, module, actor_name, actor)
      end)
    end)

    capture_graphql_surface(output_dir)
  end

  defp capture_grid_meta(output_dir, name, module, actor_name, actor) do
    case SynieWeb.GridMeta.resolve(name, actor) do
      {:ok, meta} ->
        write_json(
          output_dir,
          "#{name}.#{actor_name}.grid.json",
          camelize_keys(meta)
        )

      {:error, error} ->
        write_json(
          output_dir,
          "#{name}.#{actor_name}.grid-unavailable.json",
          %{
            available: false,
            resource: name,
            module: inspect(module),
            error: error
          }
        )
    end
  end

  defp capture_graphql_surface(output_dir) do
    %{data: data} = Absinthe.run!(@introspection, SynieWeb.Schema)

    surface =
      Map.new(@graphql_fields, fn {root, wanted} ->
        fields =
          data
          |> Map.fetch!(root)
          |> Map.fetch!("fields")
          |> Enum.filter(&(&1["name"] in wanted))
          |> Enum.sort_by(& &1["name"])

        {root,
         %{
           "expectedFields" => wanted,
           "publishedFields" => fields,
           "missingFields" => wanted -- Enum.map(fields, & &1["name"])
         }}
      end)

    write_json(
      output_dir,
      "graphql-surface.json",
      Map.merge(surface, %{
        "recordTypes" => %{
          "SysAuditLog" => data["sysAuditLog"],
          "SysTodo" => data["sysTodo"],
          "SysTodoState" => data["sysTodoState"]
        },
        "sysTodoStatePublished" => not is_nil(data["sysTodoState"])
      })
    )
  end

  defp write_json(output_dir, filename, value) do
    output = Path.join(output_dir, filename)
    File.write!(output, Jason.encode!(value, pretty: true) <> "\n")
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
    CaptureSystemContract.run(output_dir)

  _ ->
    raise """
    usage:
      mix run .scratch/migration/capture_system_contract.exs OUTPUT_DIR
    """
end
