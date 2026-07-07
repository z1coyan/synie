defmodule SynieCore.Repo do
  use AshPostgres.Repo, otp_app: :synie_core

  def installed_extensions do
    ["ash-functions", "citext"]
  end
end
