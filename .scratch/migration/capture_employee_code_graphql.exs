defmodule CaptureEmployeeCodeGraphQL do
  @mutation """
  mutation CreateEmployee($input: CreateHrEmployeeInput!) {
    createHrEmployee(input: $input) {
      result { id code name }
      errors { message }
    }
  }
  """

  def run(output) do
    prefix = "ZZR210GQL"

    actor = %SynieCore.Authz.Actor{
      user_id: Ecto.UUID.generate(),
      super_admin: true
    }

    results =
      SynieCore.Repo.transaction(fn ->
        disabled_rules =
          SynieCore.Repo.query!("""
          UPDATE sys_numbering_rule
          SET enabled = false
          WHERE resource = 'hr.employee' AND enabled
          RETURNING id::text
          """).rows
          |> List.flatten()

        result = %{
          "schema" => input_schema(),
          "temporarilyDisabledRuleCount" => length(disabled_rules),
          "withoutRule" => run_cases(actor, prefix <> "N"),
          "withRule" => with_rule(actor, prefix <> "Y")
        }

        # 旧 dev 库可能已有真实员工编号规则。整个探针固定在同一数据库事务内：
        # 暂停规则、测试员工、临时规则、计数器与审计最终全部回滚，不污染或覆盖真实配置。
        SynieCore.Repo.rollback(result)
      end)

    {:error, results} = results

    File.mkdir_p!(Path.dirname(output))
    File.write!(output, Jason.encode!(results, pretty: true) <> "\n")
  end

  defp input_schema do
    query = """
    query {
      __type(name: "CreateHrEmployeeInput") {
        inputFields {
          name
          type { kind name ofType { kind name } }
        }
      }
    }
    """

    {:ok, result} = Absinthe.run(query, SynieWeb.Schema)

    result.data["__type"]["inputFields"]
    |> Enum.find(&(&1["name"] == "code"))
  end

  defp run_cases(actor, prefix) do
    [
      {"missing", %{"name" => prefix <> "-missing"}},
      {"null", %{"code" => nil, "name" => prefix <> "-null"}},
      {"empty", %{"code" => "", "name" => prefix <> "-empty"}},
      {"whitespace", %{"code" => "   ", "name" => prefix <> "-whitespace"}}
    ]
    |> Map.new(fn {name, input} ->
      {name, run_case(actor, input)}
    end)
  end

  defp run_case(actor, input) do
    {:ok, result} =
      Absinthe.run(
        @mutation,
        SynieWeb.Schema,
        context: %{actor: actor},
        variables: %{"input" => input}
      )

    cond do
      get_in(result, [:data, "createHrEmployee", "result", "id"]) ->
        row = get_in(result, [:data, "createHrEmployee", "result"])
        %{"kind" => "created", "code" => row["code"]}

      errors = get_in(result, [:data, "createHrEmployee", "errors"]) ->
        %{
          "kind" => "actionError",
          "messages" => Enum.map(errors, & &1["message"])
        }

      errors = result[:errors] ->
        %{
          "kind" => "graphqlError",
          "messages" => Enum.map(errors, & &1.message)
        }
    end
  end

  defp with_rule(actor, prefix) do
    rule_id =
      SynieCore.Repo.query!(
        """
        INSERT INTO sys_numbering_rule (
          resource, name, segments, per_company, enabled
        )
        VALUES (
          'hr.employee',
          $1,
          ARRAY[$2::text::jsonb, $3::text::jsonb],
          false,
          true
        )
        RETURNING id
        """,
        [
          prefix <> "-rule",
          Jason.encode!(%{"type" => "text", "value" => prefix <> "-"}),
          Jason.encode!(%{"type" => "seq", "padding" => 3})
        ]
      ).rows
      |> hd()
      |> hd()

    _ = rule_id
    run_cases(actor, prefix)
  end
end

case System.argv() do
  [output] ->
    CaptureEmployeeCodeGraphQL.run(output)

  _ ->
    raise """
    usage:
      mix run .scratch/migration/capture_employee_code_graphql.exs OUTPUT
    """
end
