defmodule SynieCore.Printing.ConverterLimiterTest do
  use ExUnit.Case, async: false

  alias SynieCore.Printing.ConverterLimiter

  defp unique_name do
    :"converter_limiter_test_#{System.unique_integer([:positive])}"
  end

  test "并发受限流器约束:max=1 时两个调用者被迫串行" do
    name = unique_name()
    start_supervised!({ConverterLimiter, max: 1, name: name})

    start = System.monotonic_time(:millisecond)

    tasks =
      for _ <- 1..2 do
        Task.async(fn ->
          :ok = ConverterLimiter.acquire(name)
          Process.sleep(150)
          ConverterLimiter.release(name)
        end)
      end

    Task.await_many(tasks, 5_000)
    elapsed = System.monotonic_time(:millisecond) - start

    # 两次 150ms 串行 ≈ 300ms；留裕量避免 flaky
    assert elapsed >= 250
  end

  test "持有者被 kill 后第二个等待者能获得令牌(DOWN 回收)" do
    name = unique_name()
    start_supervised!({ConverterLimiter, max: 1, name: name})

    test_pid = self()

    holder =
      spawn(fn ->
        :ok = ConverterLimiter.acquire(name)
        send(test_pid, :holder_acquired)
        Process.sleep(:infinity)
      end)

    assert_receive :holder_acquired, 1_000

    _waiter =
      spawn(fn ->
        :ok = ConverterLimiter.acquire(name)
        send(test_pid, :waiter_acquired)
      end)

    # max=1 已被 holder 占用，此时 waiter 应仍在排队
    refute_receive :waiter_acquired, 200

    Process.exit(holder, :kill)

    assert_receive :waiter_acquired, 1_000
  end
end
