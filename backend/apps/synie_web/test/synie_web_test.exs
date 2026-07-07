defmodule SynieWebTest do
  use ExUnit.Case
  doctest SynieWeb

  test "greets the world" do
    assert SynieWeb.hello() == :world
  end
end
