package marketsched

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/domain/base/market"
)

type fakeLastClient struct{ quote market.LastQuote }

func (client fakeLastClient) FetchLast(context.Context, string) (market.LastQuote, error) {
	return client.quote, nil
}

type fakeSettlementClient struct{ quote market.SettlementQuote }

func (client fakeSettlementClient) FetchSettlement(context.Context, string, time.Time) (market.SettlementQuote, error) {
	return client.quote, nil
}

// 调度器自身拉取面向全部启用拉取的品种;测试用注入 runner 限定到本测试品种,
// 避免与并行跑同一测试库的其他包互相污染,摘要断言走 actor_id IS NULL 的调度审计行。
func TestPostgresSchedulerTickRecordsSummary(t *testing.T) {
	databaseURL := testDatabaseURL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	suffix := strings.ReplaceAll(uuid.NewString(), "-", "")[:10]
	currencyID, unitID := uuid.New(), uuid.New()
	if _, err = pool.Exec(ctx, `INSERT INTO bas_currency(id,name,iso_code) VALUES($1,'调度测试币',$2)`,
		currencyID, "S"+strings.ToUpper(suffix[:2])); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO bas_unit(id,unit_type,is_base,name,symbol,ratio) VALUES($1,'weight',false,'调度测试单位',$2,1)`,
		unitID, "s"+suffix); err != nil {
		t.Fatal(err)
	}
	var origSchedule, origSettlement bool
	var origInterval int
	if err = pool.QueryRow(ctx, `SELECT market_fetch_schedule_enabled,market_fetch_last_interval_minutes,
		market_fetch_settlement_enabled
		FROM sys_setting ORDER BY id LIMIT 1`).
		Scan(&origSchedule, &origInterval, &origSettlement); err != nil {
		t.Fatal(err)
	}
	var instrumentID uuid.UUID
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		if instrumentID != uuid.Nil {
			_, _ = pool.Exec(cleanupCtx, "DELETE FROM bas_market_price_point WHERE instrument_id=$1", instrumentID)
			_, _ = pool.Exec(cleanupCtx, "DELETE FROM bas_market_instrument WHERE id=$1", instrumentID)
		}
		// 摘要是共享单行上的易变运行态,只恢复开关/间隔;不碰摘要,避免把并行测试刚写的摘要冲掉
		_, _ = pool.Exec(cleanupCtx, `UPDATE sys_setting SET market_fetch_schedule_enabled=$1,
			market_fetch_last_interval_minutes=$2,market_fetch_settlement_enabled=$3`,
			origSchedule, origInterval, origSettlement)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM sys_audit_log
			WHERE actor_id IS NULL AND resource='sys_setting' AND action_name='record_market_fetch'`)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM sys_audit_log WHERE actor_id IS NULL AND resource='bas_market_price_point'")
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM bas_unit WHERE id=$1", unitID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM bas_currency WHERE id=$1", currencyID)
	})
	if _, err = pool.Exec(ctx, `UPDATE sys_setting SET market_fetch_schedule_enabled=true,
		market_fetch_last_interval_minutes=60,market_fetch_settlement_enabled=true`); err != nil {
		t.Fatal(err)
	}

	// 启用拉取的品种:外部最新价代码与品种组齐备
	if err = pool.QueryRow(ctx, `INSERT INTO bas_market_instrument
		(code,name,source_type,default_price_kind,active,fetch_enabled,
		 external_last_code,external_product_group,currency_id,unit_id)
		VALUES($1,'调度测试品种','EXCHANGE','SETTLEMENT',true,true,'CU0','cu',$2,$3) RETURNING id`,
		"SCH_"+suffix, currencyID, unitID).Scan(&instrumentID); err != nil {
		t.Fatal(err)
	}

	marketService := market.NewService(pool)
	scheduler := New(pool, nil)
	scheduler.runLasts = func(runCtx context.Context, now time.Time) (market.RefreshResult, error) {
		return marketService.RefreshLastsWithClient(runCtx, nil, &instrumentID, now,
			fakeLastClient{quote: market.LastQuote{Price: decimal.RequireFromString("66666")}})
	}
	scheduler.runSettlements = func(runCtx context.Context, now time.Time) (market.RefreshResult, error) {
		return marketService.RefreshSettlementsWithClient(runCtx, nil, &instrumentID, now,
			fakeSettlementClient{quote: market.SettlementQuote{
				Price: decimal.RequireFromString("55555"), DeliveryMonth: "2609", OpenInterest: 100,
			}})
	}

	// 节拍一:2026-07-17(周五)09:00 上海 → 整点槽+日盘时段,触发定时最新价
	// 每拍前把摘要重置为唯一标记:并行跑同一测试库的其他用例可能写过相同摘要,
	// 审计 Diff 会省略未变化字段,导致断言看不到本次写入
	resetMarketFetchSummary(t, ctx, pool, "marker-lasts-"+suffix)
	scheduler.now = func() time.Time { return time.Date(2026, 7, 17, 1, 0, 20, 0, time.UTC) }
	scheduler.tick(ctx)
	assertSchedulerSummary(t, ctx, pool, "定时最新价: 成功1 跳过0 失败0")

	// 节拍二:同日 15:30 上海 → 工作日结算尝试槽,触发定时结算价
	resetMarketFetchSummary(t, ctx, pool, "marker-settlement-"+suffix)
	scheduler.now = func() time.Time { return time.Date(2026, 7, 17, 7, 30, 20, 0, time.UTC) }
	scheduler.tick(ctx)
	assertSchedulerSummary(t, ctx, pool, "定时结算价: 成功1 跳过0 失败0")

	var pointCount int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM bas_market_price_point
		WHERE instrument_id=$1 AND source='fetch'`, instrumentID).Scan(&pointCount); err != nil {
		t.Fatal(err)
	}
	if pointCount != 2 {
		t.Fatalf("pointCount = %d, want 2", pointCount)
	}
}

func TestPostgresSchedulerPanicRecordsFailureSummary(t *testing.T) {
	databaseURL := testDatabaseURL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM sys_audit_log
			WHERE actor_id IS NULL AND resource='sys_setting' AND action_name='record_market_fetch'`)
	})

	// 摘要重置为唯一标记,保证本次失败摘要相对现状是变化、必出现在审计 Diff 中
	// (此前运行可能已写过相同的 "运行异常: boom",Diff 会省略未变化字段)
	resetMarketFetchSummary(t, ctx, pool, "marker-panic-"+strings.ReplaceAll(uuid.NewString(), "-", "")[:10])
	scheduler := New(pool, nil)
	func() {
		defer func() {
			if recovered := recover(); recovered != nil {
				t.Fatalf("runSafely 不应外抛 panic: %v", recovered)
			}
		}()
		scheduler.runSafely(ctx, "定时最新价", func(context.Context) (market.RefreshResult, error) {
			panic("boom")
		})
	}()
	assertSchedulerSummary(t, ctx, pool, "定时最新价: 运行异常: boom")
}

// 调度路径(nil actor)写的摘要审计行可与并行测试(有 actor)隔离。
// 一次运行可能同事务写多行审计(run_at 与摘要文本分行),inserted_at 相同时
// 单行 LIMIT 1 的次序不确定,故取最近若干行做 contains 判定。
func assertSchedulerSummary(t *testing.T, ctx context.Context, pool *pgxpool.Pool, want string) {
	t.Helper()
	rows, err := pool.Query(ctx, `SELECT changes::text FROM sys_audit_log
		WHERE actor_id IS NULL AND resource='sys_setting' AND action_name='record_market_fetch'
		ORDER BY inserted_at DESC LIMIT 10`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var all []string
	for rows.Next() {
		var changes string
		if err := rows.Scan(&changes); err != nil {
			t.Fatal(err)
		}
		all = append(all, changes)
		if strings.Contains(changes, want) {
			return
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	t.Fatalf("scheduler summary audits = %v, want one containing %q", all, want)
}

// resetMarketFetchSummary 把共享设置单行的行情摘要覆写为唯一标记,
// 使随后的摘要写入对审计 Diff 一定是变化(共享单行 + 并行测试下的断言前提)。
func resetMarketFetchSummary(t *testing.T, ctx context.Context, pool *pgxpool.Pool, marker string) {
	t.Helper()
	if _, err := pool.Exec(ctx, `UPDATE sys_setting SET market_fetch_last_summary=$1`, marker); err != nil {
		t.Fatal(err)
	}
}

func testDatabaseURL(t *testing.T) string {
	t.Helper()
	value := os.Getenv("SYNIE_TEST_DATABASE_URL")
	if value == "" {
		t.Skip("set SYNIE_TEST_DATABASE_URL to run the real PostgreSQL test")
	}
	return value
}
