defmodule SynieWeb.Application do
  @moduledoc false

  use Application

  @impl true
  def start(_type, _args) do
    # 待办产生/关闭戳:core 经 telemetry 抛出,这里桥接到 PubSub 供在线消费
    :telemetry.attach(
      "synie-web-sys-todo-changed",
      [:synie_core, :sys_todo, :changed],
      &__MODULE__.handle_todo_changed/4,
      nil
    )

    children = [
      {Phoenix.PubSub, name: SynieWeb.PubSub},
      SynieWeb.LoginRateLimiter,
      SynieWeb.Endpoint
    ]

    opts = [strategy: :one_for_one, name: SynieWeb.Supervisor]
    Supervisor.start_link(children, opts)
  end

  @doc false
  def handle_todo_changed(_event, _measurements, metadata, _config) do
    Phoenix.PubSub.broadcast(SynieWeb.PubSub, "sys_todo", {:todo_changed, metadata})
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
