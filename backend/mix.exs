defmodule Backend.MixProject do
  use Mix.Project

  def project do
    [
      apps_path: "apps",
      version: "0.1.0",
      start_permanent: Mix.env() == :prod,
      releases: releases(),
      deps: deps()
    ]
  end

  # Dependencies listed here are available only for this
  # project and cannot be accessed from applications inside
  # the apps folder.
  #
  # Run "mix help deps" for examples and options.
  defp deps do
    []
  end

  # 生产部署 release(Docker 构建用,见 backend/Dockerfile):
  # 单 release 包含两个 umbrella 应用
  defp releases do
    [
      synie: [
        applications: [synie_core: :permanent, synie_web: :permanent]
      ]
    ]
  end
end
