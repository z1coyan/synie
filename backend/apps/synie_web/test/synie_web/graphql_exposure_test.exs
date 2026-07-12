defmodule SynieWeb.GraphqlExposureTest do
  use ExUnit.Case, async: true

  # 生产/测试环境(graphiql_enabled 默认 false)下,GraphiQL playground 不应被挂载。
  # 直接对 SynieWeb.Router 的路由表断言,证明交互式查询控制台在关闭态不可达。
  # 参照 schema_grid_test.exs 的模块结构。

  defp routes, do: SynieWeb.Router.__routes__()

  describe "GraphiQL playground 暴露面" do
    test "关闭态(test env,graphiql_enabled=false)下 playground 未挂载" do
      # 没有任何路由使用 Absinthe.Plug.GraphiQL 作为 plug
      refute Enum.any?(routes(), &(&1.plug == Absinthe.Plug.GraphiQL)),
             "GraphiQL playground 不应在 graphiql_enabled=false 时被挂载"

      # /graphql/playground 路径不存在于路由表
      refute Enum.any?(routes(), &(&1.path == "/graphql/playground")),
             "/graphql/playground 路由不应存在"
    end

    test "GraphQL endpoint(/graphql,Absinthe.Plug)仍正常挂载" do
      # 正向对照:关闭 playground 不影响业务用的 /graphql 端点
      assert Enum.any?(routes(), &(&1.path == "/graphql" and &1.plug == Absinthe.Plug)),
             "/graphql 的 Absinthe.Plug endpoint 应保持挂载"
    end
  end
end
