# 07 — 测试基础设施沉淀（testutil + CI 跑 PG 集成测试）

**What to build:** 写测试的人不再需要复制粘贴基础设施：`internal/testutil` 提供统一的真实数据库门控与建库助手（消灭现有 12+ 处逐文件复制的环境变量检查样板），测试数据库的准备、迁移、清理一个函数搞定。更重要的是，PG 集成测试从「只在开发者本地跑、CI 永远 Skip」变为在 CI 真实运行——用 CI 的 PostgreSQL service 或 testcontainers 二选一落地，迁移类 bug 在合并前被拦住。

**Blocked by:** 01 — CI 增加 Go server 门禁（CI job 存在后才有挂载 PG 测试的位置）

**Status:** ready-for-agent

- [ ] `internal/testutil` 落地，各域 postgres_test 的门控/建库样板全部替换为公共助手
- [ ] CI 中 Go 测试在真实 PostgreSQL 上运行，PG 集成测试不再 Skip
- [ ] 测试数据库隔离策略明确（每包独立 schema/库或等价机制），并发跑测试不互相干扰
- [ ] 本地 `make test` 体验不变或更好
