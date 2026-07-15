defmodule SynieCore.Inv.MaterialCategoryTest do
  use ExUnit.Case, async: true

  alias SynieCore.Authz.Actor
  alias SynieCore.Inv.MaterialCategory

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)
  end

  defp category!(attrs) do
    MaterialCategory
    |> Ash.Changeset.for_create(:create, attrs)
    |> Ash.create!(authorize?: false)
  end

  defp actor(permissions) do
    %Actor{user_id: Ash.UUID.generate(), permissions: MapSet.new(permissions)}
  end

  test "创建根分类与子分类,has_children 反映有无下级" do
    root = category!(%{code: "01", name: "原材料", is_leaf: false})
    leaf = category!(%{code: "0101", name: "钢材", parent_id: root.id})

    assert leaf.is_leaf

    root = Ash.get!(MaterialCategory, root.id, load: [:has_children], authorize?: false)
    leaf = Ash.get!(MaterialCategory, leaf.id, load: [:has_children], authorize?: false)
    assert root.has_children
    refute leaf.has_children
  end

  test "分类编号全局唯一" do
    category!(%{code: "01", name: "原材料"})

    assert_raise Ash.Error.Invalid, fn ->
      category!(%{code: "01", name: "重复编号"})
    end
  end

  test "上级分类不能选自身" do
    cat = category!(%{code: "01", name: "原材料", is_leaf: false})

    assert_raise Ash.Error.Invalid, fn ->
      cat
      |> Ash.Changeset.for_update(:update, %{parent_id: cat.id})
      |> Ash.update!(authorize?: false)
    end
  end

  test "叶子分类下不能挂子分类" do
    leaf = category!(%{code: "01", name: "原材料"})

    assert_raise Ash.Error.Invalid, fn ->
      category!(%{code: "0101", name: "钢材", parent_id: leaf.id})
    end
  end

  test "存在下级分类不能改为叶子分类" do
    root = category!(%{code: "01", name: "原材料", is_leaf: false})
    category!(%{code: "0101", name: "钢材", parent_id: root.id})

    assert_raise Ash.Error.Invalid, fn ->
      root
      |> Ash.Changeset.for_update(:update, %{is_leaf: true})
      |> Ash.update!(authorize?: false)
    end
  end

  test "编号与上级可改" do
    root = category!(%{code: "01", name: "原材料", is_leaf: false})
    other = category!(%{code: "02", name: "半成品", is_leaf: false})
    leaf = category!(%{code: "0101", name: "钢材", parent_id: root.id})

    moved =
      leaf
      |> Ash.Changeset.for_update(:update, %{code: "0201", parent_id: other.id})
      |> Ash.update!(authorize?: false)

    assert moved.code == "0201"
    assert moved.parent_id == other.id
  end

  test "存在下级分类不能删除,叶子可删" do
    root = category!(%{code: "01", name: "原材料", is_leaf: false})
    leaf = category!(%{code: "0101", name: "钢材", parent_id: root.id})

    assert_raise Ash.Error.Invalid, fn ->
      root |> Ash.Changeset.for_destroy(:destroy) |> Ash.destroy!(authorize?: false)
    end

    :ok = leaf |> Ash.Changeset.for_destroy(:destroy) |> Ash.destroy!(authorize?: false)
    :ok = root |> Ash.Changeset.for_destroy(:destroy) |> Ash.destroy!(authorize?: false)
  end

  test "全局共享:有读权限即可见全部,无权限被拒" do
    category!(%{code: "01", name: "原材料"})

    rows = Ash.read!(MaterialCategory, actor: actor(["inv.material_category:read"]))
    assert length(rows) == 1

    assert_raise Ash.Error.Forbidden, fn ->
      Ash.read!(MaterialCategory, actor: actor([]))
    end
  end

  test "资源声明了权限前缀" do
    assert MaterialCategory.permission_prefix() == "inv.material_category"
    assert MaterialCategory.permission_actions() == ~w(create read update delete)
  end
end
