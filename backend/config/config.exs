import Config

config :synie_core,
  ash_domains: [SynieCore],
  ecto_repos: [SynieCore.Repo]

# 银行流水导入:文件里的本地时间按该偏移转 UTC(默认 UTC+8,国内无夏令时)
config :synie_core, bank_import_utc_offset_minutes: 480
config :synie_core, attendance_import_utc_offset_minutes: 480

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

# ExAws 默认使用 hackney；改用项目已有的 Req，避免引入存在安全漏洞的 hackney 1.x。
config :ex_aws, http_client: ExAws.Request.Req

import_config "#{config_env()}.exs"
