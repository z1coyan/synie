defmodule SynieCore.Application do
  use Application

  @impl true
  def start(_type, _args) do
    children = [
      SynieCore.Repo
    ]

    opts = [strategy: :one_for_one, name: SynieCore.Supervisor]
    Supervisor.start_link(children, opts)
  end
end
