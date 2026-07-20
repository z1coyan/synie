# 行情演示数据 seed:90 天历史价点(工作日频率),与 2026-07-19 起的真实拉取数据衔接
# 用法: cd backend && PORT=4199 mix run /tmp/seed_market_demo.exs
# 幂等:先删除 2026-07-19 之前的 fetch 价点(该时点后的真实拉取数据不动)

alias SynieCore.Base.MarketInstrument
alias SynieCore.Repo
import Ecto.Query

:rand.seed(:exsss, {42, 42, 42})

cutoff = ~N[2026-07-19 00:00:00]
start_date = ~D[2026-04-21]
end_date = ~D[2026-07-18]

weekdays =
  Date.range(start_date, end_date)
  |> Enum.filter(&(Date.day_of_week(&1) <= 5))

n = length(weekdays)
IO.puts("工作日 #{n} 天: #{hd(weekdays)} ~ #{List.last(weekdays)}")

# ── 工具 ──

# 对数随机游走 + 终点锚定:首点≈start,末点=target,中间随机
defmodule Walk do
  def path(n, start, target, sigma) do
    rets = for _ <- 1..n, do: :rand.normal() * sigma
    cum = Enum.scan(rets, &(&1 + &2))
    final = List.last(cum)
    drift = :math.log(target / start) - final

    cum
    |> Enum.with_index(1)
    |> Enum.map(fn {c, i} -> start * :math.exp(c + drift * i / n) end)
  end

  # 日内 last 点:围绕基准价小幅游走
  def intra(base, count, sigma) do
    Enum.scan(1..count, base, fn _, p -> p * (1 + :rand.normal() * sigma) end)
  end
end

# UTC 时刻(北京 -8h):结算/均价=07:00Z(北京15:00);日盘 01-07Z;夜盘 13-15Z
defmodule T do
  def at(date, hour) do
    NaiveDateTime.new!(date, Time.new!(hour, 0, 0))
  end

  def settlement_at(date), do: at(date, 7)

  def last_hours do
    # 日盘 09:00-15:00 北京 = 01:00-07:00Z;夜盘 21:00-23:00 北京 = 13:00-15:00Z
    [1, 2, 3, 4, 5, 6, 7, 13, 14, 15]
  end
end

# ── 品种 ──

insts =
  MarketInstrument
  |> Ash.read!(authorize?: false)
  |> Map.new(&{&1.code, &1})

cu = insts["SHFE_CU"]
al = insts["SHFE_AL"]
ag = insts["SHFE_AG"]
cj = insts["CJ_CU"]

# 日频基准路径(锚定到真实数据前的衔接价)
cu_path = Walk.path(n, 97_500, 103_500, 0.009)
al_path = Walk.path(n, 22_450, 23_150, 0.007)
ag_path = Walk.path(n, 12_150, 13_680, 0.013)

# 长江铜(现货):跟随沪铜路径,加缓变基差(-0.2%~+0.4%)
basis =
  Enum.scan(1..n, 0.001, fn _, b ->
    (b + :rand.normal() * 0.0008) |> max(-0.002) |> min(0.004)
  end)

cj_path = Enum.zip(cu_path, basis) |> Enum.map(fn {p, b} -> p * (1 + b) end)

series = [
  {cu, cu_path, 0.0015},
  {cj, cj_path, 0.0015},
  {al, al_path, 0.0012},
  {ag, ag_path, 0.0025}
]

now = NaiveDateTime.utc_now() |> NaiveDateTime.truncate(:second)

# 裸表 insert_all 无 schema,uuid 需手动 dump 成 16 字节
defmodule U do
  def new, do: Ecto.UUID.dump!(Ecto.UUID.generate())
  def dump!(id), do: Ecto.UUID.dump!(id)
end

rows =
  for {inst, path, sigma_intra} <- series,
      {date, base} <- Enum.zip(weekdays, path) do
    settle = base |> round()
    # 均价≈结算价 ±0.15%
    avg = round(base * (1 + :rand.normal() * 0.0015))
    # 日内 10 个 last 点
    lasts = Walk.intra(base, length(T.last_hours()), sigma_intra) |> Enum.map(&round/1)

    common = %{
      instrument_id: U.dump!(inst.id),
      currency_id: U.dump!(inst.currency_id),
      unit_id: U.dump!(inst.unit_id),
      source: "fetch",
      is_voided: false,
      note: nil,
      inserted_at: now,
      updated_at: now
    }

    [
      Map.merge(common, %{
        id: U.new(),
        observed_at: T.settlement_at(date),
        price: Decimal.new(settle),
        price_kind: "settlement"
      }),
      Map.merge(common, %{
        id: U.new(),
        observed_at: T.settlement_at(date),
        price: Decimal.new(avg),
        price_kind: "average"
      })
    ] ++
      (Enum.zip(T.last_hours(), lasts)
       |> Enum.map(fn {h, p} ->
         Map.merge(common, %{
           id: U.new(),
           observed_at: T.at(date, h),
           price: Decimal.new(p),
           price_kind: "last"
         })
       end))
  end
  |> List.flatten()

IO.puts("待插入 #{length(rows)} 行")

# 幂等:清掉窗口内旧 seed(source=fetch 且早于真实数据)
{deleted, _} =
  from(p in "bas_market_price_point",
    where: p.observed_at < ^cutoff and p.source == "fetch"
  )
  |> Repo.delete_all()

IO.puts("已清理旧 seed #{deleted} 行")

rows
|> Enum.chunk_every(500)
|> Enum.each(fn chunk ->
  Repo.insert_all("bas_market_price_point", chunk)
end)

IO.puts("插入完成 #{length(rows)} 行")

# 校验
for {inst, _, _} <- series do
  cnt =
    from(p in "bas_market_price_point",
      where: p.instrument_id == ^inst.id and p.is_voided == false
    )
    |> Repo.aggregate(:count)

  IO.puts("#{inst.code}: 共 #{cnt} 点")
end
