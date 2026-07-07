defmodule SynieWeb.ErrorJSON do
  def render("404.json", _assigns) do
    %{errors: %{detail: "Not found"}}
  end

  def render("500.json", _assigns) do
    %{errors: %{detail: "Internal server error"}}
  end
end
