// Package testutil 沉淀跨包测试基础设施：真实 PostgreSQL 的环境门控与
// 连接池生命周期，避免每个测试文件复制同一段样板。
//
// # 门控约定
//
// 依赖真实数据库的测试统一经 DatabaseURL / NewPool 接入：
// 未设置 SYNIE_TEST_DATABASE_URL 时一律 Skip（本地无库的 `make test`
// 体验不变、全绿）；设置后真实执行（CI 的 server job 提供该变量并先跑迁移）。
//
// # 测试数据库隔离约定（现状）
//
// 全部 PG 集成测试共享同一个测试库（SYNIE_TEST_DATABASE_URL 指向的库），
// Go 测试框架按包并行执行，跨包并发是常态。现有隔离依赖以下约定：
//
//   - 每个测试用 uuid 后缀生成唯一的编码/名称/ISO 码等业务键，不与并发
//     测试撞唯一约束；断言尽量限定在自建数据范围内。
//   - 测试结束用 t.Cleanup 删除自建行（含 sys_audit_log 等审计表），
//     保证同一库可并发、可重复（-count=N）跑。
//   - sys_setting 是全库共享单行：settings / market / marketsched 三个包
//     的测试都会读写它。settings 与 market 测试先保存原值、Cleanup 还原；
//     marketsched 测试改用唯一标记重置摘要字段，避免并发下 Diff 断言互相
//     干扰。新增测试如触碰共享单行，必须遵循同样的「保存-还原 / 唯一标记」
//     约定，且不断言其绝对取值。
//   - bas_unit 对 is_base=true 有全库唯一的「每单位类型一行」约束：插入
//     基准单位时 unit_type 必须取每次运行唯一的值（如 "order-"+suffix），
//     不得用 'quantity' 之类的字面量，否则与并行包撞唯一索引。
//   - 不借用共享种子行/他包临时行（如 SELECT ... LIMIT 1 取 bas_currency），
//     并行包的清理可能在你引用后把它删掉，造成外键竞争；自带数据一律自建。
//   - 若要彻底隔离（每包独立 schema/库），需另行演进，本包暂不提供。
package testutil

import (
	"context"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// DatabaseURLEnv 是真实 PostgreSQL 集成测试的环境门控变量。
const DatabaseURLEnv = "SYNIE_TEST_DATABASE_URL"

// DatabaseURL 返回测试数据库 DSN；未设置门控变量时 Skip 当前测试。
func DatabaseURL(t *testing.T) string {
	t.Helper()
	url := os.Getenv(DatabaseURLEnv)
	if url == "" {
		t.Skipf("set %s to run the real PostgreSQL test", DatabaseURLEnv)
	}
	return url
}

// NewPool 建立到测试数据库的连接池，并注册 t.Cleanup 自动关闭。
// 未设置门控变量时 Skip 当前测试；建池失败直接 Fatal。
// ctx 的超时由调用方按测试规模自行决定。
func NewPool(t *testing.T, ctx context.Context) *pgxpool.Pool {
	t.Helper()
	pool, err := pgxpool.New(ctx, DatabaseURL(t))
	if err != nil {
		t.Fatalf("connect test database: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}
