# 已废弃:空库只需 mix ecto.migrate,打开应用走初始化向导即可。
# 向导完成时会幂等种子:内置存储接入 local、编号规则、物料两级分类。
# 本脚本保留为空操作,避免旧文档/脚本 `mix run seeds.exs` 报错。
#
# 运行:cd backend/apps/synie_core && mix run priv/repo/seeds.exs

IO.puts("seeds.exs 已无实际动作:环境与业务预置均由初始化向导完成(Setup.complete)。")
