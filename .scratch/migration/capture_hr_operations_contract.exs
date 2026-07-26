defmodule CaptureHrOperationsContract do
  @resources [
    {"hrAttendancePunches", SynieCore.Hr.AttendancePunch},
    {"hrAttendanceImports", SynieCore.Hr.AttendanceImport},
    {"hrAttendanceDays", SynieCore.Hr.AttendanceDay},
    {"hrAttendanceCorrections", SynieCore.Hr.AttendanceCorrection},
    {"hrPayrolls", SynieCore.Hr.Payroll},
    {"hrPayrollPayments", SynieCore.Hr.PayrollPayment},
    {"hrEmployeeLoans", SynieCore.Hr.EmployeeLoan}
  ]

  @query_fields [
    "hrAttendancePunches",
    "hrAttendanceImports",
    "hrAttendanceDays",
    "hrAttendanceCorrections",
    "hrAttendanceMonthSummary",
    "hrPayrolls",
    "hrPayrollPayments",
    "hrPayrollMonthStats",
    "hrEmployeeLoans",
    "hrEmployeeLoanBalances"
  ]

  @mutation_fields [
    "createHrAttendanceImport",
    "importHrAttendanceImport",
    "destroyHrAttendanceImport",
    "createHrAttendanceCorrection",
    "updateHrAttendanceCorrection",
    "destroyHrAttendanceCorrection",
    "recalcHrAttendanceDays",
    "createHrPayroll",
    "updateHrPayroll",
    "refreshHrPayroll",
    "destroyHrPayroll",
    "generateHrPayrolls",
    "createHrPayrollPayment",
    "payRemainingHrPayrollPayment",
    "destroyHrPayrollPayment",
    "createHrEmployeeLoan",
    "updateHrEmployeeLoan",
    "destroyHrEmployeeLoan"
  ]

  @internal_fields [
    "createHrAttendancePunch",
    "updateHrAttendancePunch",
    "destroyHrAttendancePunch",
    "createHrAttendanceDay",
    "updateHrAttendanceDay",
    "destroyHrAttendanceDay",
    "markPaidHrPayroll",
    "markPendingHrPayroll",
    "autoRepayHrEmployeeLoan",
    "autoDestroyHrEmployeeLoan"
  ]

  @introspection """
  query {
    query: __type(name: "RootQueryType") {
      fields {
        name
        description
        args {
          name
          description
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
          description
          defaultValue
          type { ...TypeRef }
        }
        type { ...TypeRef }
      }
    }
    schema: __schema {
      types {
        kind
        name
        description
        fields {
          name
          description
          args {
            name
            description
            defaultValue
            type { ...TypeRef }
          }
          type { ...TypeRef }
        }
        inputFields {
          name
          description
          defaultValue
          type { ...TypeRef }
        }
        enumValues {
          name
          description
        }
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
          ofType {
            kind
            name
          }
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
         permissions:
           MapSet.new([
             "hr.attendance_punch:read",
             "hr.attendance_day:read",
             "hr.attendance_correction:read",
             "hr.payroll:read",
             "hr.payroll_payment:read",
             "hr.employee_loan:read",
             "hr.employee:read",
             "sys.file:read",
             "sys.user:read"
           ])
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
        write_json(output_dir, "#{name}.#{actor_name}.grid.json", camelize_keys(meta))

      {:error, error} ->
        write_json(
          output_dir,
          "#{name}.#{actor_name}.grid-unavailable.json",
          %{available: false, resource: name, module: inspect(module), error: error}
        )
    end
  end

  defp capture_graphql_surface(output_dir) do
    %{data: data} = Absinthe.run!(@introspection, SynieWeb.Schema)

    query = filter_root(data["query"]["fields"], @query_fields)
    mutation = filter_root(data["mutation"]["fields"], @mutation_fields)
    all_root_names = Enum.map(data["query"]["fields"] ++ data["mutation"]["fields"], & &1["name"])

    types =
      data["schema"]["types"]
      |> Enum.filter(fn type ->
        name = type["name"] || ""

        Regex.match?(
          ~r/Hr(Attendance(Punch|Import|Day|Correction)|Payroll(Payment)?|EmployeeLoan)/,
          name
        )
      end)
      |> Enum.sort_by(& &1["name"])

    write_json(output_dir, "graphql-surface.json", %{
      "query" => %{
        "expectedFields" => @query_fields,
        "publishedFields" => query,
        "missingFields" => @query_fields -- Enum.map(query, & &1["name"])
      },
      "mutation" => %{
        "expectedFields" => @mutation_fields,
        "publishedFields" => mutation,
        "missingFields" => @mutation_fields -- Enum.map(mutation, & &1["name"])
      },
      "internalFieldsExpectedAbsent" => @internal_fields,
      "internalFieldsUnexpectedlyPublished" =>
        Enum.filter(@internal_fields, &(&1 in all_root_names)),
      "types" => types
    })
  end

  defp filter_root(fields, wanted) do
    fields
    |> Enum.filter(&(&1["name"] in wanted))
    |> Enum.sort_by(& &1["name"])
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
    CaptureHrOperationsContract.run(output_dir)

  _ ->
    raise """
    usage:
      mix run .scratch/migration/capture_hr_operations_contract.exs OUTPUT_DIR
    """
end
