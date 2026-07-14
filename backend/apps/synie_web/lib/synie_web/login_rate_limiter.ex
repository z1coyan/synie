defmodule SynieWeb.LoginRateLimiter do
  @moduledoc """
  登录暴破限流:按 bucket_key(用户名+IP)的固定时间窗口计数。
  进程内 ETS,单节点有效;超过阈值即在窗口内拒绝,无论密码对错。
  """
  use GenServer

  @table :login_rate_limiter
  @window_seconds 300
  @max_attempts 10

  def start_link(opts), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  @doc "记一次失败尝试,返回该窗口累计次数。"
  def record_failure(bucket_key) do
    slot = {bucket_key, window_index()}
    :ets.update_counter(@table, slot, {2, 1}, {slot, 0})
  end

  @doc "当前窗口是否已被限流(达到或超过阈值)。"
  def blocked?(bucket_key) do
    slot = {bucket_key, window_index()}

    case :ets.lookup(@table, slot) do
      [{^slot, count}] -> count >= @max_attempts
      [] -> false
    end
  end

  @doc "认证成功后清除该 key 的当前窗口计数。"
  def reset(bucket_key) do
    :ets.delete(@table, {bucket_key, window_index()})
    :ok
  end

  def max_attempts, do: @max_attempts
  def window_seconds, do: @window_seconds

  @impl true
  def init(_opts) do
    :ets.new(@table, [
      :named_table,
      :public,
      :set,
      read_concurrency: true,
      write_concurrency: true
    ])

    {:ok, %{}}
  end

  defp window_index, do: div(System.system_time(:second), @window_seconds)
end
