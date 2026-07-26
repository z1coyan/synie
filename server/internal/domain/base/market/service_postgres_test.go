package market

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

func TestPostgresMarketLifecycleAuditAndSeries(t *testing.T) {
	databaseURL := os.Getenv("SYNIE_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("set SYNIE_TEST_DATABASE_URL to run the real PostgreSQL test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	suffix := strings.ReplaceAll(uuid.NewString(), "-", "")[:10]
	userID, currencyID, unitID := uuid.New(), uuid.New(), uuid.New()
	if _, err = pool.Exec(ctx, `INSERT INTO sys_user(id,username,name,hashed_password) VALUES($1,$2,'行情测试','test-only')`,
		userID, "market_"+suffix); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO bas_currency(id,name,iso_code) VALUES($1,'行情测试币',$2)`,
		currencyID, strings.ToUpper(suffix[:3])); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO bas_unit(id,unit_type,is_base,name,symbol,ratio) VALUES($1,'weight',false,'行情测试单位',$2,1)`,
		unitID, "m"+suffix); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM bas_market_price_point WHERE instrument_id IN (SELECT id FROM bas_market_instrument WHERE code LIKE $1)", "MKT_"+suffix+"%")
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM bas_market_instrument WHERE code LIKE $1", "MKT_"+suffix+"%")
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM sys_audit_log WHERE actor_id=$1", userID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM bas_unit WHERE id=$1", unitID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM bas_currency WHERE id=$1", currencyID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM sys_user WHERE id=$1", userID)
	})

	service := NewService(pool)
	actor := &authz.Actor{UserID: userID, Username: "market_" + suffix}
	instrument, err := service.CreateInstrument(ctx, actor, InstrumentCreate{
		Code: "MKT_" + suffix, Name: "测试行情", SourceType: "EXCHANGE",
		DefaultPriceKind: "SETTLEMENT", CurrencyID: currencyID, UnitID: unitID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if instrument.SourceType != "EXCHANGE" || instrument.DefaultPriceKind != "SETTLEMENT" || !instrument.Active {
		t.Fatalf("instrument = %#v", instrument)
	}
	point, err := service.CreatePricePoint(ctx, actor, PricePointCreate{
		InstrumentID: instrument.ID, ObservedAt: time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC),
		Price: decimal.RequireFromString("100"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if point.CurrencyID != currencyID || point.UnitID != unitID || point.PriceKind != "SETTLEMENT" {
		t.Fatalf("point = %#v", point)
	}
	if _, err = service.CreatePricePoint(ctx, actor, PricePointCreate{
		InstrumentID: instrument.ID, ObservedAt: point.ObservedAt, Price: decimal.RequireFromString("101"),
	}); errorCode(err) != apierror.CodeConflict {
		t.Fatalf("duplicate point err = %#v", err)
	}
	series, err := service.PriceSeries(ctx, []uuid.UUID{instrument.ID}, "settlement",
		point.ObservedAt.Add(-time.Hour), point.ObservedAt.Add(time.Hour))
	if err != nil || len(series.Series) != 1 || len(series.Series[0].Points) != 1 {
		t.Fatalf("series = %#v, err=%v", series, err)
	}
	if series.PriceKind != "settlement" || series.Series[0].DefaultPriceKind != "settlement" {
		t.Fatalf("series casing = %#v", series)
	}
	voided, err := service.VoidPricePoint(ctx, actor, point.ID)
	if err != nil || !voided.IsVoided {
		t.Fatalf("voided = %#v, err=%v", voided, err)
	}
	if _, err = service.VoidPricePoint(ctx, actor, point.ID); errorCode(err) != apierror.CodeValidation {
		t.Fatalf("second void err = %#v", err)
	}
	if err = service.DeleteInstrument(ctx, actor, instrument.ID); errorCode(err) != apierror.CodeConflict {
		t.Fatalf("delete with points err = %#v", err)
	}
	var auditCount int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM sys_audit_log WHERE actor_id=$1 AND resource=ANY($2)`,
		userID, []string{"bas_market_instrument", "bas_market_price_point"}).Scan(&auditCount); err != nil {
		t.Fatal(err)
	}
	if auditCount < 3 {
		t.Fatalf("audit count = %d", auditCount)
	}
}

func errorCode(err error) apierror.Code {
	var target *apierror.Error
	if errors.As(err, &target) {
		return target.Code
	}
	return ""
}
