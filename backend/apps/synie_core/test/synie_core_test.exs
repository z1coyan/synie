defmodule SynieCoreTest do
  use ExUnit.Case
  doctest SynieCore

  test "greets the world" do
    assert SynieCore.hello() == :world
  end
end
