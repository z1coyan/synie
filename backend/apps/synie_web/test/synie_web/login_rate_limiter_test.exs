defmodule SynieWeb.LoginRateLimiterTest do
  use ExUnit.Case, async: true
  alias SynieWeb.LoginRateLimiter

  defp fresh_key, do: {"u_#{System.unique_integer([:positive])}", {127, 0, 0, 1}}

  test "阈值内不限流" do
    key = fresh_key()
    for _ <- 1..(LoginRateLimiter.max_attempts() - 1), do: LoginRateLimiter.record_failure(key)
    refute LoginRateLimiter.blocked?(key)
  end

  test "达到阈值即限流" do
    key = fresh_key()
    for _ <- 1..LoginRateLimiter.max_attempts(), do: LoginRateLimiter.record_failure(key)
    assert LoginRateLimiter.blocked?(key)
  end

  test "reset 清零" do
    key = fresh_key()
    for _ <- 1..LoginRateLimiter.max_attempts(), do: LoginRateLimiter.record_failure(key)
    assert LoginRateLimiter.blocked?(key)
    LoginRateLimiter.reset(key)
    refute LoginRateLimiter.blocked?(key)
  end

  test "不同 key 相互隔离" do
    k1 = fresh_key()
    k2 = fresh_key()
    for _ <- 1..LoginRateLimiter.max_attempts(), do: LoginRateLimiter.record_failure(k1)
    assert LoginRateLimiter.blocked?(k1)
    refute LoginRateLimiter.blocked?(k2)
  end
end
