defmodule SynieCoreTest do
  use ExUnit.Case

  test "SynieCore 域注册了全部业务资源" do
    resources = SynieCore |> Ash.Domain.Info.resources()

    for resource <- [
          SynieCore.Accounts.User,
          SynieCore.Authz.Role,
          SynieCore.Base.Company,
          SynieCore.Audit.Log
        ] do
      assert resource in resources
    end
  end
end
