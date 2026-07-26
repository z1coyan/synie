package market

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

type fakeLastClient struct{ quote LastQuote }

func (client fakeLastClient) FetchLast(context.Context, string) (LastQuote, error) {
	return client.quote, nil
}

type fakeSettlementClient struct{ quote SettlementQuote }

func (client fakeSettlementClient) FetchSettlement(context.Context, string, time.Time) (SettlementQuote, error) {
	return client.quote, nil
}

func TestPostgresMarketRefreshWithInjectedClients(t *testing.T) {
	databaseURL := testDatabaseURL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	suffix := strings.ReplaceAll(uuid.NewString(), "-", "")[:10]
	userID, currencyID, unitID := uuid.New(), uuid.New(), uuid.New()
	if _, err = pool.Exec(ctx, `INSERT INTO sys_user(id,username,name,hashed_password) VALUES($1,$2,'刷新测试','test-only')`,
		userID, "refresh_"+suffix); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO bas_currency(id,name,iso_code) VALUES($1,'刷新测试币',$2)`,
		currencyID, "R"+strings.ToUpper(suffix[:2])); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO bas_unit(id,unit_type,is_base,name,symbol,ratio) VALUES($1,'weight',false,'刷新测试单位',$2,1)`,
		unitID, "r"+suffix); err != nil {
		t.Fatal(err)
	}
	var originalRunAt *time.Time
	var originalSummary *string
	if err = pool.QueryRow(ctx, `SELECT market_fetch_last_run_at,market_fetch_last_summary FROM sys_setting ORDER BY id LIMIT 1`).
		Scan(&originalRunAt, &originalSummary); err != nil {
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
		_, _ = pool.Exec(cleanupCtx, `UPDATE sys_setting SET market_fetch_last_run_at=$1,market_fetch_last_summary=$2`,
			originalRunAt, originalSummary)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM sys_audit_log WHERE actor_id=$1", userID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM bas_unit WHERE id=$1", unitID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM bas_currency WHERE id=$1", currencyID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM sys_user WHERE id=$1", userID)
	})

	service := NewService(pool)
	actor := &authz.Actor{UserID: userID, Username: "refresh_" + suffix}
	enabled := true
	lastCode, group := "CU0", "cu"
	instrument, err := service.CreateInstrument(ctx, actor, InstrumentCreate{
		Code: "REF_" + suffix, Name: "刷新品种", SourceType: "EXCHANGE",
		DefaultPriceKind: "SETTLEMENT", FetchEnabled: &enabled,
		ExternalLastCode: &lastCode, ExternalProductGroup: &group,
		CurrencyID: currencyID, UnitID: unitID,
	})
	if err != nil {
		t.Fatal(err)
	}
	instrumentID = instrument.ID
	now := time.Date(2026, 7, 17, 8, 0, 45, 0, time.UTC)
	result, err := service.RefreshWithClients(ctx, actor, &instrument.ID, now,
		fakeLastClient{quote: LastQuote{Price: decimal.RequireFromString("88888")}},
		fakeSettlementClient{quote: SettlementQuote{
			Price: decimal.RequireFromString("77000"), DeliveryMonth: "2609", OpenInterest: 100,
		}})
	if err != nil {
		t.Fatal(err)
	}
	if result.Count != 2 || result.Items[0].Status != "ok" || result.Items[1].Status != "ok" {
		t.Fatalf("refresh = %#v", result)
	}
	rows, err := pool.Query(ctx, `SELECT observed_at,price_kind,source FROM bas_market_price_point
		WHERE instrument_id=$1 ORDER BY observed_at`, instrument.ID)
	if err != nil {
		t.Fatal(err)
	}
	type pointRow struct {
		at           time.Time
		kind, source string
	}
	var points []pointRow
	for rows.Next() {
		var point pointRow
		if err = rows.Scan(&point.at, &point.kind, &point.source); err != nil {
			t.Fatal(err)
		}
		points = append(points, point)
	}
	rows.Close()
	if len(points) != 2 ||
		!points[0].at.Equal(time.Date(2026, 7, 17, 7, 0, 0, 0, time.UTC)) ||
		!points[1].at.Equal(time.Date(2026, 7, 17, 8, 0, 0, 0, time.UTC)) ||
		points[0].source != "fetch" || points[1].source != "fetch" {
		t.Fatalf("points = %#v", points)
	}
	result, err = service.RefreshWithClients(ctx, actor, &instrument.ID, now,
		fakeLastClient{}, fakeSettlementClient{})
	if err != nil || result.Items[0].Status != "skipped" || result.Items[1].Status != "skipped" {
		t.Fatalf("duplicate refresh = %#v, err=%v", result, err)
	}
	var summary *string
	if err = pool.QueryRow(ctx, `SELECT market_fetch_last_summary FROM sys_setting ORDER BY id LIMIT 1`).Scan(&summary); err != nil {
		t.Fatal(err)
	}
	if summary == nil || !strings.Contains(*summary, "手动刷新") {
		t.Fatalf("summary = %#v", summary)
	}
	var systemAudit int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM sys_audit_log
		WHERE actor_id=$1 AND resource='sys_setting' AND action_name='record_market_fetch'`, userID).Scan(&systemAudit); err != nil {
		t.Fatal(err)
	}
	if systemAudit == 0 {
		t.Fatal("refresh summary audit missing")
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
