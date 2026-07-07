defmodule SynieCoreTest do
  use ExUnit.Case

  test "SynieCore is an Ash Domain exposing the Hello resource" do
    resources = SynieCore |> Ash.Domain.Info.resources()
    assert SynieCore.Resources.Hello in resources
  end
end
