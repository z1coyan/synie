defmodule SynieWeb.MixProject do
  use Mix.Project

  def project do
    [
      app: :synie_web,
      version: "0.1.0",
      build_path: "../../_build",
      config_path: "../../config/config.exs",
      deps_path: "../../deps",
      lockfile: "../../mix.lock",
      elixir: "~> 1.20",
      start_permanent: Mix.env() == :prod,
      deps: deps()
    ]
  end

  # Run "mix help compile.app" to learn about applications.
  def application do
    [
      extra_applications: [:logger],
      mod: {SynieWeb.Application, []}
    ]
  end

  # Run "mix help deps" to learn about dependencies.
  defp deps do
    [
      {:synie_core, in_umbrella: true},
      {:phoenix, "~> 1.7"},
      {:phoenix_html, "~> 4.0"},
      {:plug_cowboy, "~> 2.7"},
      {:jason, "~> 1.4"},
      {:ash_graphql, "~> 1.9"},
      {:ash_authentication, "~> 4.0"},
      {:ash_authentication_phoenix, "~> 2.0"},
      {:bandit, "~> 1.5"}
    ]
  end
end
