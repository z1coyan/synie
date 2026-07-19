defmodule SynieCore.Inv.Stock do
  @moduledoc """
  库存过账模块:库存来源单据审核/作废统一经此读写分录,勿直接操作 `StockEntry`
  (照 `SynieCore.Acc.GL` 先例)。

  数量带符号单字段(入正出负),无单位——恒为物料默认单位口径,`sum(quantity)` 即余额。

  `post!/2` 内部先校验(行数、数量非零、仓存在且同公司且叶子、物料存在)再过
  负库存校验、最后批量插入,违规直接抛错——单据侧正常流程不应触发(纵深防御,
  未来所有 voucher 共用)。`cancel!/2` 作废会致负(如作废入库单)同样拒绝,
  与审核同一口径。调用方(单据的审核/作废动作)自带事务,本模块不另开。

  负库存校验(审核/作废同一口径):按 (仓×物料)「Σ 未作废分录 + 本次变动 ≥ 0」,
  仓 `allow_negative` 跳过;只校验当前总余额,不做逐时点重放(补录历史单的穿零
  问题留跟进,见 ADR 2026-07-19-stock-ledger)。并发抢货兜底:校验前对涉及的
  (仓, 物料) 键排序后逐个 `pg_advisory_xact_lock`,与调用方动作同事务。
  """

  require Ash.Query

  alias SynieCore.Inv.{Material, StockEntry, Warehouse}

  @entry_keys [:warehouse_id, :material_id, :quantity, :remarks]

  @doc """
  voucher_type → {来源单据资源, 中文标签}(GridMeta 多态 fk 反射用)。
  新库存单据接 Inv.Stock(调 post!/cancel!)时必须在此注册,分录的来源单据列
  才能渲染成链接。
  """
  def voucher_resources do
    %{
      "inv.stock_doc" => {SynieCore.Inv.StockDoc, "手工出入库单"},
      "inv.stock_transfer" => {SynieCore.Inv.StockTransfer, "手工调拨单"},
      "inv.stock_count" => {SynieCore.Inv.StockCount, "库存盘点单"}
    }
  end

  @doc """
  过账:voucher 需含 `voucher_type/voucher_id/voucher_no/company_id/posting_date`,
  entries 为含 `#{inspect(@entry_keys)}` 的 map 列表(quantity 带符号,remarks 可空)。
  """
  def post!(voucher, entries) do
    case check_entries(voucher.company_id, entries) do
      :ok -> :ok
      {:error, msg} -> raise ArgumentError, "过账校验失败:#{msg}"
    end

    entries
    |> Enum.map(&{&1[:warehouse_id], &1[:material_id], dec(&1[:quantity])})
    |> check_balances!()

    rows =
      Enum.map(entries, fn entry ->
        entry
        |> Map.take(@entry_keys)
        |> Map.merge(%{
          company_id: voucher.company_id,
          posting_date: voucher.posting_date,
          voucher_type: voucher.voucher_type,
          voucher_id: voucher.voucher_id,
          voucher_no: voucher.voucher_no
        })
      end)

    %Ash.BulkResult{status: :success} =
      Ash.bulk_create(rows, StockEntry, :create,
        authorize?: false,
        return_errors?: true,
        stop_on_error?: true
      )

    :ok
  end

  @doc "作废:标记某单据全部库存分录 `is_cancelled`;作废会致负(如作废入库单)同样拒绝。"
  def cancel!(voucher_type, voucher_id) do
    live_entries =
      StockEntry
      |> Ash.Query.filter(
        voucher_type == ^voucher_type and voucher_id == ^voucher_id and is_cancelled == false
      )
      |> Ash.read!(authorize?: false)

    # 作废的效应 = 把该单据的未作废分录从余额中减掉,与审核同一负库存口径
    live_entries
    |> Enum.map(&{&1.warehouse_id, &1.material_id, Decimal.negate(&1.quantity)})
    |> check_balances!()

    %Ash.BulkResult{status: :success} =
      StockEntry
      |> Ash.Query.filter(voucher_type == ^voucher_type and voucher_id == ^voucher_id)
      |> Ash.bulk_update(:mark_cancelled, %{cancelled_at: DateTime.utc_now()},
        strategy: :atomic,
        authorize?: false,
        return_errors?: true
      )

    :ok
  end

  # 分录组校验:行数≥1、数量非零、仓存在且同公司且叶子、物料存在。
  # 仓停用不拦——「拦新不拦旧」在单据保存侧,过账只认结构约束(见 ADR)。
  defp check_entries(company_id, entries) do
    with :ok <- check_count(entries),
         :ok <- check_quantities(entries) do
      check_warehouses_materials(company_id, entries)
    end
  end

  defp check_count(entries) when length(entries) >= 1, do: :ok
  defp check_count(_entries), do: {:error, "分录不少于一行"}

  defp check_quantities(entries) do
    if Enum.all?(entries, &(Decimal.compare(dec(&1[:quantity]), 0) != :eq)) do
      :ok
    else
      {:error, "数量不能为零"}
    end
  end

  defp check_warehouses_materials(company_id, entries) do
    warehouse_ids = entries |> Enum.map(& &1[:warehouse_id]) |> Enum.uniq()
    material_ids = entries |> Enum.map(& &1[:material_id]) |> Enum.uniq()

    warehouses = load_map(Warehouse, warehouse_ids)
    materials = load_map(Material, material_ids)

    cond do
      Enum.any?(warehouse_ids, &(not Map.has_key?(warehouses, &1))) ->
        {:error, "仓库不存在"}

      Enum.any?(warehouse_ids, &(Map.fetch!(warehouses, &1).company_id != company_id)) ->
        {:error, "仓库必须属于单据公司"}

      Enum.any?(warehouse_ids, &(not Map.fetch!(warehouses, &1).is_leaf)) ->
        {:error, "只有叶子仓库才能发生库存"}

      Enum.any?(material_ids, &(not Map.has_key?(materials, &1))) ->
        {:error, "物料不存在"}

      true ->
        :ok
    end
  end

  # 负库存校验(审核/作废同一口径):deltas 为 {warehouse_id, material_id, 数量变动}
  # 列表,按 (仓×物料) 汇总后逐键校验「Σ 未作废分录 + 本次变动 ≥ 0」,
  # 仓 allow_negative 跳过;任一不过整单拒(抛错,含仓名与物料名)。
  defp check_balances!(deltas) do
    deltas =
      deltas
      |> Enum.group_by(fn {warehouse_id, material_id, _qty} -> {warehouse_id, material_id} end)
      |> Map.new(fn {key, list} ->
        {key, list |> Enum.map(&elem(&1, 2)) |> Enum.reduce(Decimal.new(0), &Decimal.add/2)}
      end)

    # 排序加锁:同一 (仓, 物料) 键的并发审核/作废在此串行化,固定顺序避免多键死锁
    keys = deltas |> Map.keys() |> Enum.sort()
    Enum.each(keys, &lock_key!/1)

    warehouses = load_map(Warehouse, Enum.map(keys, &elem(&1, 0)))
    balances = current_balances(keys)

    Enum.each(keys, fn {warehouse_id, material_id} = key ->
      warehouse = Map.fetch!(warehouses, warehouse_id)

      if not warehouse.allow_negative do
        delta = Map.fetch!(deltas, key)
        balance = Map.get(balances, key, Decimal.new(0))

        if Decimal.compare(Decimal.add(balance, delta), 0) == :lt do
          # 物料名仅在报错路径上取(正常路径不浪费一次查询)
          material_name =
            case Ash.get(Material, material_id, authorize?: false) do
              {:ok, material} -> material.name
              _ -> material_id
            end

          raise ArgumentError,
                "仓「#{warehouse.name}」物料「#{material_name}」库存不足:" <>
                  "当前余额 #{fmt(balance)},本次变动 #{fmt(delta)}"
        end
      end
    end)

    :ok
  end

  # (仓, 物料) 键的事务级咨询锁;仅在调用方动作事务内才有效(锁持有到事务提交)
  defp lock_key!({warehouse_id, material_id}) do
    SynieCore.Repo.query!(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      ["inv_stock:#{warehouse_id}:#{material_id}"]
    )

    :ok
  end

  # 各 (仓, 物料) 键当前余额(Σ 未作废分录)
  defp current_balances(keys) do
    warehouse_ids = keys |> Enum.map(&elem(&1, 0)) |> Enum.uniq()
    material_ids = keys |> Enum.map(&elem(&1, 1)) |> Enum.uniq()

    StockEntry
    |> Ash.Query.filter(
      is_cancelled == false and warehouse_id in ^warehouse_ids and material_id in ^material_ids
    )
    |> Ash.read!(authorize?: false)
    |> Enum.group_by(&{&1.warehouse_id, &1.material_id}, & &1.quantity)
    |> Map.new(fn {key, quantities} ->
      {key, Enum.reduce(quantities, Decimal.new(0), &Decimal.add/2)}
    end)
  end

  defp load_map(resource, ids) do
    resource
    |> Ash.Query.filter(id in ^Enum.uniq(ids))
    |> Ash.read!(authorize?: false)
    |> Map.new(&{&1.id, &1})
  end

  defp dec(nil), do: Decimal.new(0)
  defp dec(value), do: Decimal.new(value)

  defp fmt(value), do: Decimal.to_string(value, :normal)
end
