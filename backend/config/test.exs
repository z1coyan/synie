import Config

# Test-specific configuration.
# The endpoint is not started in the test environment; SynieWeb.Endpoint
# config here only satisfies Phoenix's compile-time requirements.

config :synie_web, SynieWeb.Endpoint,
  http: [ip: {127, 0, 0, 1}, port: 4002],
  secret_key_base: "synie_test_secret_key_base_for_test_only_not_for_prod",
  server: false

config :logger, level: :warning

# 测试中降低 pbkdf2 轮数,加快涉及密码哈希的用例
config :pbkdf2_elixir, rounds: 1

# 本地 synie-pg 容器仍是 postgres:16(docker-compose.yml 已声明 postgres:17,容器待升级),
# 而 SynieCore.Repo.min_pg_version 按生产目标声明 17;AshPostgres 按声明版本(不探测实际服务端)
# 选择 MERGE 语句做 upsert,PG16 不支持 MERGE...RETURNING 会报语法错误,故本地关闭该优化路径,
# 回退到 ON CONFLICT 实现(行为一致)。容器升级到 17 后可删除本行。
config :ash_postgres, upsert_with_merge?: false

# OCR HTTP 走 Req.Test 桩,测试不出网
config :synie_core, ocr_req_options: [plug: {Req.Test, SynieCore.Ocr.AliyunClient}]

# 行情拉取:测试不启调度;HTTP 分别桩新浪/上期所
config :synie_core, market_fetch_scheduler: false

config :synie_core,
  market_fetch_sina_req_options: [plug: {Req.Test, SynieCore.Base.MarketFetch.SinaClient}]

config :synie_core,
  market_fetch_shfe_req_options: [plug: {Req.Test, SynieCore.Base.MarketFetch.ShfeClient}]
