# 环境层初始化:存储接入点、编号规则等无需人决策的数据。
# 业务初始化(首个管理员、首个公司等)由初始化向导承担——迁移跑完后打开应用即进入;
# 内置角色、CNY 等由迁移种子。首个管理员不再由本脚本创建。
# 运行:cd backend/apps/synie_core && mix run priv/repo/seeds.exs

require Ash.Query

# 内置存储接入:local(全局默认,不可删除)。已存在则跳过,不覆盖用户改过的 root。
alias SynieCore.Files.StorageEndpoint

local =
  StorageEndpoint
  |> Ash.Query.filter(name == "local")
  |> Ash.read_one!(authorize?: false)

if local do
  IO.puts("存储接入 local 已存在,跳过创建")
else
  root = System.get_env("UPLOADS_ROOT") || "uploads"

  StorageEndpoint
  |> Ash.Changeset.for_create(:create, %{name: "local", label: "本地存储", kind: :local, root: root})
  |> Ash.Changeset.force_change_attribute(:builtin, true)
  |> Ash.Changeset.force_change_attribute(:is_default, true)
  |> Ash.create!(authorize?: false)

  IO.puts("已创建内置存储接入 local(根目录 #{root})")
end

# 物料编号规则:分类编号+客户编号(空则省略)+"-"+4 位序号。
# 通用料 01-0001、客户 77 料 0177-0001;计数范围=非序号段文本,按分类×客户分桶。
# 物料是全局主数据,不按公司计数。已有该资源规则(含用户改过的)则跳过,不覆盖。
alias SynieCore.Numbering.Rule

material_rule =
  Rule
  |> Ash.Query.filter(resource == "inv.material")
  |> Ash.read!(authorize?: false)
  |> List.first()

if material_rule do
  IO.puts("物料编号规则已存在,跳过创建")
else
  Rule
  |> Ash.Changeset.for_create(:create, %{
    resource: "inv.material",
    name: "物料编号",
    segments: [
      %{"type" => "field", "field" => "category.code"},
      %{"type" => "field", "field" => "customer.code"},
      %{"type" => "text", "value" => "-"},
      %{"type" => "seq", "padding" => 4}
    ],
    per_company: false,
    enabled: true
  })
  |> Ash.create!(authorize?: false)

  IO.puts("已创建物料编号规则(分类+客户编号-4 位序号)")
end
