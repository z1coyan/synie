defmodule SynieCore.Base.MarketFetch do
  @moduledoc """
  行情拉取门面:对启用拉取的品种写 `source=fetch` 价点。

  - 盘中/手动:最新价(`last`),观测时刻=拉取成功时刻
  - 日终:结算价(`settlement`),观测时刻锚定交易日 15:00 上海;已有有效点则跳过
  - 定时是否跑、最新价间隔、结算自动补:读 `sys_setting`;跑完写上次摘要
  """

  require Ash.Query
  require Logger

  alias SynieCore.Base.MarketFetch.Sessions
  alias SynieCore.Base.MarketFetch.ShfeClient
  alias SynieCore.Base.MarketFetch.SinaClient
  alias SynieCore.Base.MarketInstrument
  alias SynieCore.Base.MarketPricePoint
  alias SynieCore.Sys.Setting

  @type item_result :: %{
          instrument_id: String.t(),
          code: String.t(),
          kind: :last | :settlement,
          status: :ok | :skipped | :error,
          message: String.t() | nil,
          price_point_id: String.t() | nil
        }

  @doc """
  手动/统一刷新。

  - `instrument_id` 为空:所有 `fetch_enabled` 且启用的品种
  - 始终尝试最新价
  - 若已过结算窗口且配置允许结算自动补,且当日尚无有效结算点,则顺带补结算
  """
  @spec refresh(keyword()) :: {:ok, map()}
  def refresh(opts \\ []) do
    instrument_id = Keyword.get(opts, :instrument_id)
    now = Keyword.get(opts, :now) || DateTime.utc_now() |> DateTime.truncate(:second)
    cfg = Setting.market_fetch_config()

    try_settlement? =
      Keyword.get(
        opts,
        :try_settlement,
        cfg.settlement_enabled and Sessions.past_settlement_window?(now)
      )

    instruments = list_fetchable(instrument_id)

    items =
      Enum.flat_map(instruments, fn inst ->
        last_item = do_fetch_last(inst, now)

        settlement_items =
          if try_settlement? do
            [do_fetch_settlement(inst, now)]
          else
            []
          end

        [last_item | settlement_items]
      end)

    result = pack_result(items)
    record_run!("手动刷新", items)
    {:ok, result}
  end

  @doc "定时:交易时段按配置间隔拉最新价。"
  @spec refresh_lasts(keyword()) :: {:ok, map()}
  def refresh_lasts(opts \\ []) do
    now = Keyword.get(opts, :now) || DateTime.utc_now() |> DateTime.truncate(:second)
    cfg = Setting.market_fetch_config()

    cond do
      not Keyword.get(opts, :force, false) and not cfg.schedule_enabled ->
        {:ok, %{"items" => [], "count" => 0, "skipped" => "schedule_disabled"}}

      Keyword.get(opts, :force, false) or Sessions.in_last_session?(now) ->
        instruments = list_fetchable(nil)
        items = Enum.map(instruments, &do_fetch_last(&1, now))
        result = pack_result(items)
        if items != [], do: record_run!("定时最新价", items)
        {:ok, result}

      true ->
        {:ok, %{"items" => [], "count" => 0, "skipped" => "outside_session"}}
    end
  end

  @doc "定时:结算窗口拉结算价。"
  @spec refresh_settlements(keyword()) :: {:ok, map()}
  def refresh_settlements(opts \\ []) do
    now = Keyword.get(opts, :now) || DateTime.utc_now() |> DateTime.truncate(:second)
    cfg = Setting.market_fetch_config()

    cond do
      not Keyword.get(opts, :force, false) and not cfg.schedule_enabled ->
        {:ok, %{"items" => [], "count" => 0, "skipped" => "schedule_disabled"}}

      not Keyword.get(opts, :force, false) and not cfg.settlement_enabled ->
        {:ok, %{"items" => [], "count" => 0, "skipped" => "settlement_disabled"}}

      Keyword.get(opts, :force, false) or Sessions.settlement_attempt_slot?(now) or
          Sessions.past_settlement_window?(now) ->
        instruments = list_fetchable(nil)
        items = Enum.map(instruments, &do_fetch_settlement(&1, now))
        result = pack_result(items)
        if items != [], do: record_run!("定时结算价", items)
        {:ok, result}

      true ->
        {:ok, %{"items" => [], "count" => 0, "skipped" => "outside_window"}}
    end
  end

  defp pack_result(items) do
    %{"items" => Enum.map(items, &stringify_item/1), "count" => length(items)}
  end

  defp record_run!(label, items) do
    ok = Enum.count(items, &(&1.status == :ok))
    skipped = Enum.count(items, &(&1.status == :skipped))
    err_items = Enum.filter(items, &(&1.status == :error))
    err = length(err_items)

    err_hint =
      case err_items do
        [%{code: c, message: m} | _] when is_binary(m) -> " 失败例 #{c}:#{m}"
        _ -> ""
      end

    summary = "#{label}: 成功#{ok} 跳过#{skipped} 失败#{err}#{err_hint}"
    Setting.record_market_fetch!(summary)
  rescue
    e ->
      Logger.warning("market_fetch record_run failed: #{Exception.message(e)}")
      :ok
  end

  defp list_fetchable(nil) do
    MarketInstrument
    |> Ash.Query.filter(fetch_enabled == true and active == true)
    |> Ash.Query.sort(code: :asc)
    |> Ash.read!(authorize?: false)
  end

  defp list_fetchable(id) do
    case Ash.get(MarketInstrument, id, authorize?: false) do
      {:ok, %{fetch_enabled: true, active: true} = inst} ->
        [inst]

      {:ok, %{code: code}} ->
        Logger.info("market_fetch skip #{code}: 未启用拉取或已停用")
        []

      {:error, _} ->
        []
    end
  end

  defp do_fetch_last(inst, now) do
    code = inst.external_last_code
    # 锚定到分钟,同一分钟内重复刷新跳过,避免双击/并发撞唯一键
    observed_at = %{now | second: 0, microsecond: {0, 0}}

    cond do
      is_nil(code) or String.trim(code) == "" ->
        item(inst, :last, :error, "未配置外部最新价代码", nil)

      has_active_point?(inst.id, observed_at, :last) ->
        item(inst, :last, :skipped, "本分钟已有最新价", nil)

      true ->
        case SinaClient.fetch_last(code) do
          {:ok, %{price: price} = quote} ->
            # note 只用 ASCII 安全片段:新浪包体是 GBK,中文名不可直接落 UTF8 库
            note =
              "sina #{code}" <>
                if(quote[:as_of_date], do: " @#{quote.as_of_date}", else: "")

            case insert_point(inst, observed_at, :last, price, note) do
              {:ok, point} ->
                item(inst, :last, :ok, nil, point.id)

              {:error, msg} ->
                item(inst, :last, :error, compact_error(msg), nil)
            end

          {:error, msg} ->
            Logger.warning("market_fetch last #{inst.code}: #{msg}")
            item(inst, :last, :error, compact_error(msg), nil)
        end
    end
  end

  defp do_fetch_settlement(inst, now) do
    group = inst.external_product_group
    trade_date = Sessions.settlement_trade_date(now)
    observed_at = Sessions.settlement_observed_at(trade_date)

    cond do
      is_nil(group) or String.trim(group) == "" ->
        item(inst, :settlement, :error, "未配置外部品种组", nil)

      has_active_point?(inst.id, observed_at, :settlement) ->
        item(inst, :settlement, :skipped, "当日结算价已存在", nil)

      true ->
        case ShfeClient.fetch_settlement(group, trade_date) do
          {:ok, %{price: price, delivery_month: month} = data} ->
            note = "shfe #{group}#{month} main OI=#{data.open_interest}"

            case insert_point(inst, observed_at, :settlement, price, note) do
              {:ok, point} ->
                item(inst, :settlement, :ok, nil, point.id)

              {:error, msg} ->
                item(inst, :settlement, :error, compact_error(msg), nil)
            end

          {:error, :not_available} ->
            item(inst, :settlement, :skipped, "日数据尚未发布或非交易日", nil)

          {:error, msg} ->
            Logger.warning("market_fetch settlement #{inst.code}: #{compact_error(msg)}")
            item(inst, :settlement, :error, compact_error(msg), nil)
        end
    end
  end

  defp has_active_point?(instrument_id, observed_at, price_kind) do
    MarketPricePoint
    |> Ash.Query.filter(
      instrument_id == ^instrument_id and
        observed_at == ^observed_at and
        price_kind == ^price_kind and
        is_voided == false
    )
    |> Ash.exists?(authorize?: false)
  end

  defp insert_point(inst, observed_at, price_kind, price, note) do
    note = note |> to_string() |> String.slice(0, 255)

    result =
      MarketPricePoint
      |> Ash.Changeset.for_create(:create, %{
        instrument_id: inst.id,
        observed_at: observed_at,
        price: price,
        price_kind: price_kind,
        source: :fetch,
        note: note
      })
      |> Ash.create(authorize?: false)

    case result do
      {:ok, point} ->
        {:ok, point}

      {:error, err} ->
        {:error, Exception.message(err)}
    end
  end

  defp item(inst, kind, status, message, price_point_id) do
    %{
      instrument_id: inst.id,
      code: inst.code,
      kind: kind,
      status: status,
      message: message,
      price_point_id: price_point_id
    }
  end

  defp stringify_item(item) do
    %{
      "instrument_id" => item.instrument_id,
      "code" => item.code,
      "kind" => to_string(item.kind),
      "status" => to_string(item.status),
      "message" => item.message,
      "price_point_id" => item.price_point_id
    }
  end

  defp compact_error(msg) when is_binary(msg) do
    msg
    |> String.replace(~r/\s+/, " ")
    |> String.slice(0, 200)
  end

  defp compact_error(other), do: other |> inspect() |> String.slice(0, 200)
end
