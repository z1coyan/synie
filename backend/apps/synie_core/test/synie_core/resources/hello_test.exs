defmodule SynieCore.Resources.HelloTest do
  use ExUnit.Case, async: true

  alias SynieCore.Resources.Hello

  test "say_hello returns a greeting for the given name" do
    result =
      Hello
      |> Ash.ActionInput.for_action(:say_hello, %{name: "world"})
      |> Ash.run_action!()

    assert result == "Hello, world"
  end

  test "say_hello rejects missing name argument" do
    assert_raise Ash.Error.Invalid, ~r/name/, fn ->
      Hello
      |> Ash.ActionInput.for_action(:say_hello, %{})
      |> Ash.run_action!()
    end
  end
end
