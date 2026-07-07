import Config

# Development-specific configuration.
# Database connection and runtime secrets are read from environment
# variables in config/runtime.exs.

config :synie_web, SynieWeb.Endpoint,
  http: [ip: {127, 0, 0, 1}, port: 4000],
  secret_key_base: "synie_dev_secret_key_base_for_development_only_not_for_prod",
  server: true,
  code_reloader: true,
  debug_errors: true