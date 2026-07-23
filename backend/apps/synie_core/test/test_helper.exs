# :minio 集成测试需本地 MinIO 容器,默认排除;mix test --include minio 跑
# :libreoffice 需本机 soffice,默认排除;mix test --include libreoffice 跑
ExUnit.start(exclude: [:minio, :libreoffice])
Ecto.Adapters.SQL.Sandbox.mode(SynieCore.Repo, :manual)
