defmodule SynieCore.Printing.ConverterLimiter do
  @moduledoc """
  PDF 转换全局并发限流器：soffice 单实例转换是重型进程（数百 MB 内存）；
  同时起太多并发会把容器内存打穿。本模块用一个令牌桶把并发转换数量限制在
  `max`（默认 2，配置键 `:synie_core, :soffice_max_concurrency`）以内，
  超过上限的调用排队等待，而不是无限制地并发起 soffice。

  用法：转换前 `acquire/0`（阻塞直到拿到令牌），转换完 `release/0` 归还。
  持有者或排队等待者进程崩溃时，通过 `Process.monitor`/`:DOWN` 自动回收令牌
  或从队列摘除，避免泄漏导致限流器永久卡死。
  """

  use GenServer

  @default_max 2

  # Client API

  @doc "启动限流器；`opts[:max]` 可覆盖 `:synie_core, :soffice_max_concurrency` 配置，供测试用。"
  def start_link(opts \\ []) do
    name = Keyword.get(opts, :name, __MODULE__)
    GenServer.start_link(__MODULE__, opts, name: name)
  end

  @doc "阻塞直到获得一个转换令牌。"
  def acquire(server \\ __MODULE__) do
    GenServer.call(server, :acquire, :infinity)
  end

  @doc "归还调用方当前持有的令牌，并唤醒队首等待者。"
  def release(server \\ __MODULE__) do
    GenServer.cast(server, {:release, self()})
  end

  # Server callbacks

  @impl true
  def init(opts) do
    max =
      Keyword.get(opts, :max) ||
        Application.get_env(:synie_core, :soffice_max_concurrency, @default_max)

    {:ok, %{max: max, in_use: %{}, waiting: :queue.new()}}
  end

  @impl true
  def handle_call(:acquire, {pid, _tag} = from, state) do
    ref = Process.monitor(pid)

    if map_size(state.in_use) < state.max do
      {:reply, :ok, %{state | in_use: Map.put(state.in_use, ref, pid)}}
    else
      {:noreply, %{state | waiting: :queue.in({from, pid, ref}, state.waiting)}}
    end
  end

  @impl true
  def handle_cast({:release, pid}, state) do
    case Enum.find(state.in_use, fn {_ref, held_pid} -> held_pid == pid end) do
      {ref, _pid} ->
        Process.demonitor(ref, [:flush])
        state = %{state | in_use: Map.delete(state.in_use, ref)}
        {:noreply, dequeue(state)}

      nil ->
        {:noreply, state}
    end
  end

  @impl true
  def handle_info({:DOWN, ref, :process, _pid, _reason}, state) do
    if Map.has_key?(state.in_use, ref) do
      # 持有者崩溃：回收令牌，唤醒队首
      state = %{state | in_use: Map.delete(state.in_use, ref)}
      {:noreply, dequeue(state)}
    else
      # 等待者崩溃：从队列摘除（无需回复，调用方已不在）
      waiting = :queue.filter(fn {_from, _pid, r} -> r != ref end, state.waiting)
      {:noreply, %{state | waiting: waiting}}
    end
  end

  defp dequeue(state) do
    case :queue.out(state.waiting) do
      {{:value, {from, pid, ref}}, rest} ->
        GenServer.reply(from, :ok)
        %{state | in_use: Map.put(state.in_use, ref, pid), waiting: rest}

      {:empty, _} ->
        state
    end
  end
end
