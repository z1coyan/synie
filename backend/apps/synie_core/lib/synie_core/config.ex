defmodule SynieCore.Config do
  @moduledoc false

  @default_pool_size "10"

  @type environment :: :dev | :test | :prod
  @type vars :: %{optional(String.t()) => String.t()}

  @spec repo_config(environment(), vars()) :: keyword()
  def repo_config(env, vars \\ System.get_env())

  def repo_config(:prod, vars) do
    [
      url: required_env!(vars, "DATABASE_URL"),
      pool_size: integer_env!(vars, "POOL_SIZE", @default_pool_size)
    ]
  end

  def repo_config(env, vars) when env in [:dev, :test] do
    config =
      case env_value(vars, "DATABASE_URL") do
        nil ->
          split_repo_config(env, vars)

        database_url ->
          [url: database_url, pool_size: integer_env!(vars, "POOL_SIZE", @default_pool_size)]
      end

    maybe_put_test_pool(env, config)
  end

  defp split_repo_config(env, vars) do
    defaults = defaults_for(env)

    [
      username: env_value(vars, "PGUSER", defaults.username),
      password: env_value(vars, "PGPASSWORD", defaults.password),
      database: env_value(vars, "PGDATABASE", defaults.database),
      hostname: env_value(vars, "PGHOST", defaults.hostname),
      port: integer_env!(vars, "PGPORT", Integer.to_string(defaults.port)),
      pool_size: integer_env!(vars, "POOL_SIZE", @default_pool_size)
    ]
  end

  defp defaults_for(:dev) do
    %{
      username: "postgres",
      password: "postgres",
      database: "synie_dev",
      hostname: "localhost",
      port: 5440
    }
  end

  defp defaults_for(:test) do
    %{
      username: "postgres",
      password: "postgres",
      database: "synie_test",
      hostname: "localhost",
      port: 5440
    }
  end

  defp maybe_put_test_pool(:test, config),
    do: Keyword.put(config, :pool, Ecto.Adapters.SQL.Sandbox)

  defp maybe_put_test_pool(_env, config), do: config

  defp required_env!(vars, name) do
    case env_value(vars, name) do
      nil -> raise "#{name} is missing"
      value -> value
    end
  end

  defp integer_env!(vars, name, default) do
    value = env_value(vars, name, default)

    case Integer.parse(value) do
      {integer, ""} -> integer
      _ -> raise "#{name} must be an integer, got: #{inspect(value)}"
    end
  end

  defp env_value(vars, name, default \\ nil) do
    case Map.get(vars, name) do
      value when is_binary(value) and value != "" -> value
      _ -> default
    end
  end
end
