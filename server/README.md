# Synie Go Server

`server/` 是 Synie ERP 唯一目标后端。Elixir `backend/` 只作为迁移期行为与契约参考，
产品路径不在 Go/GraphQL 之间切换。

## 已定技术选择

- HTTP：chi v5
- PostgreSQL：pgx/v5；固定 SQL 由 sqlc 生成，动态筛选由 Meta 白名单 predicate builder
- DDL：goose；`db/migrations/00001_baseline.sql` 是当前开发库 schema-only 基线
- 小数：shopspring/decimal；JSON 只接受字符串，金额 half-up
- 契约：`../contracts/openapi/openapi.yaml` + oapi-codegen
- 密码：argon2id
- Token：**JWT HS256**，`iss=synie`，默认 7 天；不兼容 Phoenix.Token/Pbkdf2

JWT 只保存用户身份和标准时效声明。权限、角色和公司范围在每次请求时从 PostgreSQL 构建
Actor，避免长期 Token 固化授权状态。

## 环境变量

复制 `.env.example` 并通过进程环境注入；server 不自动读取 `.env`：

```text
HTTP_ADDR=:8080
DATABASE_URL=postgres://postgres:postgres@localhost:5441/synie?sslmode=disable
AUTH_SECRET=<至少 32 字节的随机值>
AUTH_TOKEN_TTL=168h
```

若未设置 `DATABASE_URL`，也可使用 `PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE/PGSSLMODE`。

## 开发命令

```bash
make generate
make test
go run ./cmd/synie
```

数据库：

```bash
make migration-up
SEED_ADMIN_PASSWORD='<至少 12 个字符>' go run ./cmd/seed
```

种子命令幂等创建超级管理员；同名用户已存在时不会覆盖密码。`/api/v1/healthz`
只有在进程和 PostgreSQL 均可用时返回 200。

也可从仓库根目录启动开发栈：

```bash
docker compose up --build
docker compose --profile tools run --rm seed
```
