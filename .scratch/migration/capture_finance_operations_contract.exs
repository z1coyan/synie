defmodule CaptureFinanceOperationsContract do
  @resources [
    {"accBankAccounts", SynieCore.Acc.BankAccount},
    {"accBankTransactions", SynieCore.Acc.BankTransaction},
    {"accBankImportTemplates", SynieCore.Acc.BankImportTemplate},
    {"accBankImports", SynieCore.Acc.BankImport},
    {"accBankImportItems", SynieCore.Acc.BankImportItem},
    {"accVatInvoices", SynieCore.Acc.VatInvoice},
    {"accExpenseReports", SynieCore.Acc.ExpenseReport},
    {"accExpenseReportItems", SynieCore.Acc.ExpenseReportItem},
    {"accBills", SynieCore.Acc.Bill},
    {"accBillTransactions", SynieCore.Acc.BillTransaction},
    {"accBillHoldings", SynieCore.Acc.BillHolding},
    {"accBankReconciliations", SynieCore.Acc.BankReconciliation}
  ]

  @query_fields [
    "accBankAccounts",
    "accBankTransactions",
    "accBankImportTemplates",
    "accBankImports",
    "accBankImportItems",
    "accVatInvoices",
    "accExpenseReports",
    "accExpenseReportItems",
    "accBills",
    "accBillTransactions",
    "accBillHoldings",
    "accBankReconciliations",
    "accBankReconciliationRemaining"
  ]

  @mutation_fields [
    "createAccBankAccount",
    "updateAccBankAccount",
    "destroyAccBankAccount",
    "createAccBankTransaction",
    "updateAccBankTransaction",
    "destroyAccBankTransaction",
    "createAccBankImportTemplate",
    "updateAccBankImportTemplate",
    "destroyAccBankImportTemplate",
    "createAccBankImport",
    "importAccBankImport",
    "destroyAccBankImport",
    "updateAccBankImportItem",
    "destroyAccBankImportItem",
    "createAccVatInvoice",
    "updateAccVatInvoice",
    "destroyAccVatInvoice",
    "auditAccVatInvoice",
    "voidAccVatInvoice",
    "reverseAccVatInvoice",
    "ocrAccVatInvoice",
    "createAccExpenseReport",
    "updateAccExpenseReport",
    "destroyAccExpenseReport",
    "auditAccExpenseReport",
    "voidAccExpenseReport",
    "createAccExpenseReportItem",
    "updateAccExpenseReportItem",
    "destroyAccExpenseReportItem",
    "updateAccBill",
    "destroyAccBill",
    "createAccBillTransaction",
    "updateAccBillTransaction",
    "destroyAccBillTransaction",
    "auditAccBillTransaction",
    "voidAccBillTransaction",
    "ocrAccBillTransaction",
    "createAccBankReconciliation",
    "quickCreateAccBankReconciliation",
    "destroyAccBankReconciliation"
  ]

  @internal_fields [
    "refreshReconcileAccBankTransaction",
    "createAccBankImportItem",
    "linkTransactionAccBankImportItem",
    "registerAccBill",
    "rebuildAccBillHolding",
    "destroyAccBillHolding"
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
             "acc.bank_account:read",
             "acc.bank_transaction:read",
             "acc.bank_import_template:read",
             "acc.vat_invoice:read",
             "acc.expense_report:read",
             "acc.bill:read",
             "acc.bill_transaction:read",
             "acc.bill_holding:read",
             "base.company:read",
             "base.account:read",
             "sys.file:read",
             "sys.user:read",
             "sales.customer:read",
             "purchase.supplier:read",
             "sales.reconciliation:read",
             "purchase.reconciliation:read"
           ])
       }}
    ]

    Enum.each(@resources, fn {name, module} ->
      Enum.each(actors, fn {actor_name, actor} ->
        capture_grid_meta(output_dir, name, module, actor_name, actor)
      end)
    end)

    capture_graphql_surface(output_dir)
    capture_meta_resolver_surface(output_dir)
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
          ~r/(Bank(Account|Transaction|Import|Reconciliation)|VatInvoice|ExpenseReport|Bill|AccInvoice(Direction|Kind|Status)|AccPartyType|AccReconcileStatus)/,
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

  # 旧 Web 层只有公开 GridMeta resolver；Record drawer 复用同一份 GridMeta，
  # 不存在可捕获的独立 RecordMeta resolver。单独落盘，防止迁移时伪造第二套契约。
  defp capture_meta_resolver_surface(output_dir) do
    write_json(output_dir, "meta-resolver-surface.json", %{
      "gridMetaResolver" => %{
        "module" => "SynieWeb.GridMeta",
        "function" => "resolve/2",
        "resources" => Enum.map(@resources, &elem(&1, 0))
      },
      "recordMetaResolver" => nil,
      "recordDrawerUsesGridMeta" => true
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
    CaptureFinanceOperationsContract.run(output_dir)

  _ ->
    raise """
    usage:
      mix run .scratch/migration/capture_finance_operations_contract.exs OUTPUT_DIR
    """
end
