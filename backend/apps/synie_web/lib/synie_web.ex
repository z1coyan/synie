defmodule SynieWeb do
  @moduledoc false

  def html do
    quote do
      use Phoenix.Component
      import Phoenix.HTML
    end
  end

  def controller do
    quote do
      use Phoenix.Controller, formats: [:html, :json]
    end
  end

  defmacro __using__(which) when is_atom(which) do
    apply(__MODULE__, which, [])
  end
end
