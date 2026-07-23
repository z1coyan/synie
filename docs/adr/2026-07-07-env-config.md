# ADR：后端运行时环境变量

2026-07-07。数据库等运行时配置统一走 `backend/config/runtime.exs`，不引入 dotenv 依赖。

- **`DATABASE_URL` 优先**；否则 dev/test 用拆分 `PG*` 变量，默认端口 **5440**（对齐本地 Docker 暴露，避免误连 5432）。
- **prod 必填** `DATABASE_URL` 与 `SECRET_KEY_BASE`，禁止开发默认值。
- dev/test 可自动加载 `backend/.env`（后加便利）；prod 不读文件。Endpoint HTTP 端口仍由 `dev.exs`/`test.exs` 管，不并入本次合约。
