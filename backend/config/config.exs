import Config

config :synie_core,
  ash_domains: [SynieCore],
  ecto_repos: [SynieCore.Repo]

config :synie_web,
  namespace: SynieWeb

# GraphiQL playground 默认关闭(生产不暴露交互式查询控制台);仅 dev 打开
config :synie_web, graphiql_enabled: false

config :synie_web, SynieWeb.Endpoint,
  url: [host: "localhost"],
  adapter: Bandit.PhoenixAdapter,
  render_errors: [
    formats: [html: SynieWeb.ErrorHTML, json: SynieWeb.ErrorJSON],
    layout: false
  ],
  pubsub_server: SynieWeb.PubSub,
  live_view: [signing_salt: "synie_salt"]

config :phoenix, :json_library, Jason
import_config "#{config_env()}.exs"
