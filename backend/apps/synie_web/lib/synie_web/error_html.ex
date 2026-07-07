defmodule SynieWeb.ErrorHTML do
  use SynieWeb, :html

  def render("404.html", _assigns) do
    "Not found"
  end

  def render("500.html", _assigns) do
    "Internal server error"
  end

  def template_not_found(_template, _assigns) do
    "Template not found"
  end
end
