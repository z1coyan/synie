defmodule SynieWeb.Application do
  @moduledoc false

  use Application

  @impl true
  def start(_type, _args) do
    children = [
      {Phoenix.PubSub, name: SynieWeb.PubSub},
      SynieWeb.Endpoint
    ]

    opts = [strategy: :one_for_one, name: SynieWeb.Supervisor]
    Supervisor.start_link(children, opts)
  end

  @impl true
  def config_change(changed, removed, _new) do
    changed
    |> Enum.concat(removed)
    |> Enum.each(fn {app, _} ->
      Application.put_env(app, :changed, true)
    end)

    :ok
  end
end
