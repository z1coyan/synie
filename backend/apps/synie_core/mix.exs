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
      # 阿里云 OCR HTTP 客户端(Req.Test 可注入 plug,测试不出网)
      {:req, "~> 0.5"},
      {:ex_aws, "~> 2.5"},
      {:ex_aws_s3, "~> 2.5"},
      {:hackney, "~> 1.20"},
      {:sweet_xml, "~> 0.7"},
      {:pbkdf2_elixir, "~> 2.3"},
      {:simple_sat, "~> 0.1"},
      {:xlsx_reader, "~> 0.8"},
      {:spreadsheet, "~> 0.6"}
    ]
  end
end
