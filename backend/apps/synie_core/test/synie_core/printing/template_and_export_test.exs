defmodule SynieCore.Printing.TemplateAndExportTest do
  use ExUnit.Case, async: true

  import SynieCore.AuthzFixtures

  alias SynieCore.Authz
  alias SynieCore.Files
  alias SynieCore.Files.StorageEndpoint
  alias SynieCore.Printing.FieldCatalog
  alias SynieCore.Printing.Template
  alias SynieCore.PrintingFixture

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)

    base = Path.join(System.tmp_dir!(), "synie_print_#{System.unique_integer([:positive])}")
    root = Path.join(base, "objects")
    File.mkdir_p!(root)

    StorageEndpoint
    |> Ash.Changeset.for_create(:create, %{
      name: "print_local_#{System.unique_integer([:positive])}",
      label: "打印测试存储",
      kind: :local,
      root: root
    })
    |> Ash.Changeset.force_change_attribute(:is_default, true)
    |> Ash.create!(authorize?: false)

    on_exit(fn -> File.rm_rf!(base) end)
    :ok
  end

  defp actor!(perms) do
    user = user!()
    role = role!()
    Enum.each(perms, &grant!(role, &1))
    assign!(user, role)
    Authz.build_actor(user)
  end

  defp upload_xlsx!(actor, rows) do
    bin = PrintingFixture.build(rows: rows)
    path = Path.join(System.tmp_dir!(), "tpl_#{System.unique_integer([:positive])}.xlsx")
    File.write!(path, bin)

    {:ok, %{file: file}} =
      Files.upload(actor, %{
        path: path,
        filename: "order.xlsx",
        content_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      })

    File.rm(path)
    file
  end

  test "FieldCatalog 校验未知占位符" do
    assert :ok =
             FieldCatalog.validate_placeholders("sales.order", ["order_no"], ["material_name", "_seq"])

    assert {:error, msg} =
             FieldCatalog.validate_placeholders("sales.order", ["nope"], ["material_name"])

    assert msg =~ "nope"

    assert {:error, _} = FieldCatalog.validate_placeholders("unknown.res", [], [])
  end

  test "创建模板：合法 xlsx 成功；未知字段拒存；设默认唯一" do
    actor =
      actor!([
        "sys.file:create",
        "sys.print_template:create",
        "sys.print_template:read",
        "sys.print_template:update"
      ])

    good = upload_xlsx!(actor, [["${order_no}", "${items.material_name}"]])

    assert {:ok, t1} =
             Template
             |> Ash.Changeset.for_create(:create, %{
               name: "订单默认",
               resource: "sales.order",
               file_id: good.id
             })
             |> Ash.create(actor: actor)

    assert t1.resource == "sales.order"
    refute t1.is_default

    bad = upload_xlsx!(actor, [["${not_a_field}"]])

    assert {:error, %Ash.Error.Invalid{}} =
             Template
             |> Ash.Changeset.for_create(:create, %{
               name: "坏模板",
               resource: "sales.order",
               file_id: bad.id
             })
             |> Ash.create(actor: actor)

    assert {:ok, t1d} =
             t1
             |> Ash.Changeset.for_update(:set_default, %{})
             |> Ash.update(actor: actor)

    assert t1d.is_default

    good2 = upload_xlsx!(actor, [["${order_no}"]])

    assert {:ok, t2} =
             Template
             |> Ash.Changeset.for_create(:create, %{
               name: "另一份",
               resource: "sales.order",
               file_id: good2.id
             })
             |> Ash.create(actor: actor)

    assert {:ok, t2d} =
             t2
             |> Ash.Changeset.for_update(:set_default, %{})
             |> Ash.update(actor: actor)

    assert t2d.is_default

    t1_re = Ash.get!(Template, t1.id, authorize?: false)
    refute t1_re.is_default
  end

  test "非 xlsx 文件名拒存" do
    actor = actor!(["sys.file:create", "sys.print_template:create"])

    path = Path.join(System.tmp_dir!(), "x_#{System.unique_integer([:positive])}.txt")
    File.write!(path, "not xlsx")

    {:ok, %{file: file}} =
      Files.upload(actor, %{path: path, filename: "note.txt", content_type: "text/plain"})

    File.rm(path)

    assert {:error, %Ash.Error.Invalid{}} =
             Template
             |> Ash.Changeset.for_create(:create, %{
               name: "文本",
               resource: "sales.order",
               file_id: file.id
             })
             |> Ash.create(actor: actor)
  end
end
