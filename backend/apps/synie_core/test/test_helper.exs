# :minio 集成测试需本地 MinIO 容器,默认排除;mix test --include minio 跑
ExUnit.start(exclude: [:minio])
Ecto.Adapters.SQL.Sandbox.mode(SynieCore.Repo, :manual)
