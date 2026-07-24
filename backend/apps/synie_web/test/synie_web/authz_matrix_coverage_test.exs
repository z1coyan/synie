defmodule SynieWeb.AuthzMatrixCoverageTest do
  @moduledoc """
  矩阵完整性守卫(expand–contract 的强制面):

  1. 权限目录清单 diff 夹具世界覆盖表——新资源进目录而没写构造函数、
     又不在豁免清单,CI 即红;豁免项落地后忘删同样红。
  2. 「声明 read 的资源必在表格元数据白名单」——读侧枚举源不漏资源,
     同机制同豁免形式。

  纯内省,不碰数据库。
  """

  use ExUnit.Case, async: true

  alias SynieCore.Authz.Registry
  alias SynieWeb.AuthzMatrix.World

  test "权限目录 diff 世界覆盖表:未覆盖资源必须在豁免清单(带理由)" do
    catalog_prefixes = Registry.catalog() |> Enum.map(& &1.prefix)
    covered = World.covered_prefixes()
    exempt = World.coverage_exempt()

    unknown_covered = covered -- catalog_prefixes

    assert unknown_covered == [],
           "世界覆盖了权限目录外的前缀(构造函数注册表写错?):#{inspect(unknown_covered)}"

    uncovered = catalog_prefixes -- covered
    offenders = uncovered -- Map.keys(exempt)

    assert offenders == [],
           "以下资源进了权限目录但没有夹具构造函数,也不在豁免清单——" <>
             "补 SynieWeb.AuthzMatrix.World 的构造函数,或带理由豁免:\n" <>
             Enum.map_join(offenders, "\n", &("  - " <> &1))

    stale = Map.keys(exempt) -- uncovered

    assert stale == [],
           "世界覆盖豁免清单中以下项已失效(已覆盖或已不在目录),请删除:\n" <>
             Enum.map_join(stale, "\n", &("  - " <> &1))

    blank = for {prefix, reason} <- exempt, String.trim(reason) == "", do: prefix
    assert blank == [], "以下豁免项没有书面理由(不允许无理由豁免):#{inspect(blank)}"
  end

  test "声明 read 的资源必在表格元数据白名单,或带理由豁免" do
    read_prefixes = for %{prefix: p, actions: a} <- Registry.catalog(), "read" in a, do: p
    grid_modules = SynieWeb.GridMeta.resources() |> Map.values() |> MapSet.new()
    modules = Registry.resource_modules()
    exempt = World.whitelist_exempt()

    missing =
      for prefix <- read_prefixes,
          not MapSet.member?(grid_modules, Map.fetch!(modules, prefix)),
          do: prefix

    offenders = missing -- Map.keys(exempt)

    assert offenders == [],
           "以下资源声明了 read 却缺席 GridMeta 白名单,也不在豁免清单——" <>
             "注册进 @resources,或带理由豁免:\n" <>
             Enum.map_join(offenders, "\n", &("  - " <> &1))

    stale = Map.keys(exempt) -- missing

    assert stale == [],
           "read 白名单豁免清单中以下项已失效(已注册或已不声明 read),请删除:\n" <>
             Enum.map_join(stale, "\n", &("  - " <> &1))

    blank = for {prefix, reason} <- exempt, String.trim(reason) == "", do: prefix
    assert blank == [], "以下豁免项没有书面理由(不允许无理由豁免):#{inspect(blank)}"
  end
end
