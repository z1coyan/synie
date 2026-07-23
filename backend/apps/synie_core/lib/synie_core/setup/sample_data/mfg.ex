defmodule SynieCore.Setup.SampleData.Mfg do
  @moduledoc """
  示例数据:生产主数据(全局共享,不分公司)。

  工序 5(下料/冲压/折弯/喷涂/装配,编号自动 M(O)-)→ 工艺模板 2(钣金件
  标准工艺含外协喷涂、铜排组件工艺,含行)→ BOM 2:配电箱壳体(钢板+螺丝+
  绝缘护套,路线经 apply_route_template 从钣金模板带入)、汇流铜排组件
  (紫铜排+端子座+绝缘护套,手工 BomRoute 行)+ 副产品 1(废铜边角料)。
  """

  alias SynieCore.Inv.Material
  alias SynieCore.Mfg.Bom
  alias SynieCore.Mfg.BomByproduct
  alias SynieCore.Mfg.BomComponent
  alias SynieCore.Mfg.BomRoute
  alias SynieCore.Mfg.Operation
  alias SynieCore.Mfg.ProcessTemplate
  alias SynieCore.Mfg.ProcessTemplateItem
  alias SynieCore.Setup.SampleData

  @doc "返回 `{ %{operations:, process_templates:, boms:}, notifications }`。"
  def seed!(master) do
    mats = master.materials

    {operations, n1} = seed_operations!()
    ops = Map.new(operations, &{&1.name, &1})

    {templates, n2} = seed_process_templates!(ops)
    {boms, n3} = seed_boms!(mats, ops, templates)

    {%{operations: operations, process_templates: templates, boms: boms}, n1 ++ n2 ++ n3}
  end

  # ---------------------------------------------------------------------------
  # 内部
  # ---------------------------------------------------------------------------

  defp seed_operations! do
    ["下料", "冲压", "折弯", "喷涂", "装配"]
    |> Enum.map_reduce([], fn name, acc ->
      {row, notifications} = SampleData.create!(Operation, %{name: name}, nil)
      {row, acc ++ notifications}
    end)
  end

  defp seed_process_templates!(ops) do
    {t1, n1} = SampleData.create!(ProcessTemplate, %{name: "钣金件标准工艺"}, nil)

    n1b =
      [
        {ops["下料"], 10, "按图下料,去毛刺", false},
        {ops["冲压"], 20, "冲孔/落料一次成型", false},
        {ops["折弯"], 30, "按图折弯,角度±1°", false},
        {ops["喷涂"], 40, "外协喷涂,RAL7035", true}
      ]
      |> Enum.flat_map(fn {operation, seq, requirement, outsourced} ->
        {_item, notifications} =
          SampleData.create!(
            ProcessTemplateItem,
            %{
              template_id: t1.id,
              operation_id: operation.id,
              seq: seq,
              requirement: requirement,
              is_outsourced: outsourced
            },
            nil
          )

        notifications
      end)

    {t2, n2} = SampleData.create!(ProcessTemplate, %{name: "铜排组件工艺"}, nil)

    n2b =
      [
        {ops["下料"], 10, "铜排定尺下料", false},
        {ops["冲压"], 20, "冲安装孔,去毛刺", false},
        {ops["装配"], 30, "端子压接,扭力按规范", false}
      ]
      |> Enum.flat_map(fn {operation, seq, requirement, outsourced} ->
        {_item, notifications} =
          SampleData.create!(
            ProcessTemplateItem,
            %{
              template_id: t2.id,
              operation_id: operation.id,
              seq: seq,
              requirement: requirement,
              is_outsourced: outsourced
            },
            nil
          )

        notifications
      end)

    {[t1, t2], n1 ++ n1b ++ n2 ++ n2b}
  end

  defp seed_boms!(mats, ops, [sheet_template | _]) do
    # BOM1 配电箱壳体:路线从钣金模板带入(apply_route_template,快照语义)
    {bom1, n1} =
      SampleData.create!(Bom, %{material_id: mats[:box_shell].id, note: "示例 BOM"}, nil)

    n1b =
      [
        {:steel_sheet, "2.5", nil, "箱体展开料"},
        {:screw, "12", "0.02", "装配紧固"},
        {:insul_sleeve, "0.5", nil, nil}
      ]
      |> Enum.flat_map(fn {key, qty, loss, note} ->
        component!(bom1, mats[key], qty, loss, note)
      end)

    {bom1, n1c} =
      SampleData.run_action!(bom1, :apply_route_template, %{template_id: sheet_template.id}, nil)

    # BOM2 汇流铜排组件:手工 BomRoute 行 + 副产品废铜边角料
    {bom2, n2} =
      SampleData.create!(Bom, %{material_id: mats[:busbar].id, note: "示例 BOM"}, nil)

    n2b =
      [
        {:copper_bar, "1.2", "0.03", nil},
        {:terminal_block, "8", nil, nil},
        {:insul_sleeve, "0.3", nil, nil}
      ]
      |> Enum.flat_map(fn {key, qty, loss, note} ->
        component!(bom2, mats[key], qty, loss, note)
      end)

    n2c =
      [{ops["下料"], 10, "铜排定尺下料"}, {ops["装配"], 20, "端子压接"}]
      |> Enum.flat_map(fn {operation, seq, requirement} ->
        {_route, notifications} =
          SampleData.create!(
            BomRoute,
            %{bom_id: bom2.id, operation_id: operation.id, seq: seq, requirement: requirement},
            nil
          )

        notifications
      end)

    {_byproduct, n2d} =
      SampleData.create!(
        BomByproduct,
        %{
          bom_id: bom2.id,
          material_id: mats[:scrap_copper].id,
          unit_id: mats[:scrap_copper].default_unit_id,
          quantity: Decimal.new("0.05"),
          note: "下料边角料"
        },
        nil
      )

    {[bom1, bom2], n1 ++ n1b ++ n1c ++ n2 ++ n2b ++ n2c ++ n2d}
  end

  defp component!(bom, %Material{} = material, qty, loss, note) do
    attrs = %{
      bom_id: bom.id,
      material_id: material.id,
      unit_id: material.default_unit_id,
      quantity: Decimal.new(qty),
      note: note
    }

    attrs = if loss, do: Map.put(attrs, :loss_rate, Decimal.new(loss)), else: attrs

    {_component, notifications} = SampleData.create!(BomComponent, attrs, nil)
    notifications
  end
end
