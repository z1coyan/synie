defmodule SynieCore.MixProject do
  use Mix.Project

  def project do
    [
      app: :synie_core,
      version: "0.1.0",
      build_path: "../../_build",
      config_path: "../../config/config.exs",
      deps_path: "../../deps",
      lockfile: "../../mix.lock",
      elixir: "~> 1.20",
      elixirc_paths: elixirc_paths(Mix.env()),
      start_permanent: Mix.env() == :prod,
      deps: deps()
    ]
  end

  defp elixirc_paths(:test), do: ["lib", "test/support"]
  defp elixirc_paths(_), do: ["lib"]

  # Run "mix help compile.app" to learn about applications.
  def application do
    [
      extra_applications: [:logger],
      mod: {SynieCore.Application, []}
    ]
  end

  # Run "mix help deps" to learn about dependencies.
  defp deps do
    [
      {:ash, "~> 3.29"},
      {:ash_postgres, "~> 2.10"},
      {:ash_graphql, "~> 1.9"},
      {:pbkdf2_elixir, "~> 2.3"},
      {:simple_sat, "~> 0.1"},
      {:xlsx_reader, "~> 0.8"}
    ]
  end
end
