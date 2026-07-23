defmodule SynieCore.Application do
  use Application

  @impl true
  def start(_type, _args) do
    children =
      [SynieCore.Repo, SynieCore.Printing.ConverterLimiter] ++
        if Application.get_env(:synie_core, :market_fetch_scheduler, true) do
          [SynieCore.Base.MarketFetch.Scheduler]
        else
          []
        end

    opts = [strategy: :one_for_one, name: SynieCore.Supervisor]
    Supervisor.start_link(children, opts)
  end
end
