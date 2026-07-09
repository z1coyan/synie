defmodule SynieCore.DomainPaginationTest do
  use ExUnit.Case, async: true

  # 约定守卫:list 查询统一 offset 分页,不留扁平列表(backend/AGENTS.md)
  test "所有 list 查询都是 offset 分页" do
    flat =
      SynieCore
      |> AshGraphql.Domain.Info.queries()
      |> Enum.filter(&(&1.type == :list and &1.paginate_with != :offset))
      |> Enum.map(& &1.name)

    assert flat == []
  end
end
