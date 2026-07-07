import Config

# Test-specific configuration.
# The endpoint is not started in the test environment; SynieWeb.Endpoint
# config here only satisfies Phoenix's compile-time requirements.

config :synie_web, SynieWeb.Endpoint,
  http: [ip: {127, 0, 0, 1}, port: 4002],
  secret_key_base: "synie_test_secret_key_base_for_test_only_not_for_prod",
  server: false

config :logger, level: :warning