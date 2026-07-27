package settings

import (
	"context"
	"encoding/json"
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

func TestPostgresSingletonSettingsValidationAuditAndSecretFiltering(t *testing.T) {
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

	service := NewService(pool)
	originalSales, err := service.GetSales(ctx)
	if err != nil {
		t.Fatal(err)
	}
	originalMfg, err := service.GetManufacturing(ctx)
	if err != nil {
		t.Fatal(err)
	}
	originalAcc, secret := readAccountingForRestore(t, ctx, pool, service)
	originalSystem, err := service.GetSystem(ctx)
	if err != nil {
		t.Fatal(err)
	}

	userID := uuid.New()
	username := "settings_" + strings.ReplaceAll(uuid.NewString(), "-", "")[:10]
	if _, err := pool.Exec(ctx, `
		INSERT INTO sys_user (id,username,name,hashed_password)
		VALUES ($1,$2,'设置测试用户','test-only')
	`, userID, username); err != nil {
		t.Fatal(err)
	}
	actor := &authz.Actor{UserID: userID, Username: username}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		restoreSettings(cleanupCtx, pool, originalSales, originalMfg, originalAcc, secret, originalSystem)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM sys_audit_log WHERE actor_id=$1", userID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM sys_user WHERE id=$1", userID)
	})

	zero := int64(0)
	if _, err := service.UpdateSales(ctx, actor, SalesUpdate{SampleItemMaxQty: &zero}); errorCode(err) != apierror.CodeValidation {
		t.Fatalf("sample max validation = %#v", err)
	}
	tooHigh := decimal.RequireFromString("1.01")
	if _, err := service.UpdateSales(ctx, actor, SalesUpdate{ReceiptOverreceiveRatio: &tooHigh}); errorCode(err) != apierror.CodeValidation {
		t.Fatalf("ratio validation = %#v", err)
	}
	badInterval := 15
	if _, err := service.UpdateSystem(ctx, actor, SystemUpdate{MarketFetchLastIntervalMinutes: &badInterval}); errorCode(err) != apierror.CodeValidation {
		t.Fatalf("interval validation = %#v", err)
	}

	sample, spot := int64(41), int64(42)
	overShip := decimal.RequireFromString("0.01")
	overReceive := decimal.RequireFromString("0.02")
	overOrder := decimal.RequireFromString("0.03")
	sales, err := service.UpdateSales(ctx, actor, SalesUpdate{
		SampleItemMaxQty: &sample, DeliveryOvershipRatio: &overShip,
		SpotItemMaxQty: &spot, ReceiptOverreceiveRatio: &overReceive,
		DemandOverorderRatio: &overOrder,
	})
	if err != nil {
		t.Fatal(err)
	}
	if sales.SampleItemMaxQty != sample || !sales.DemandOverorderRatio.Equal(overOrder) {
		t.Fatalf("sales = %#v", sales)
	}

	outputRatio := decimal.RequireFromString("0.04")
	mfg, err := service.UpdateManufacturing(ctx, actor, ManufacturingUpdate{OutputOverreceiveRatio: &outputRatio})
	if err != nil || !mfg.OutputOverreceiveRatio.Equal(outputRatio) {
		t.Fatalf("mfg = %#v, %v", mfg, err)
	}

	keyID := "  test-key-id  "
	firstSecret := "first-secret"
	acc, err := service.UpdateAccounting(ctx, actor, AccountingUpdate{
		OCRAccessKeyID: optionalString(&keyID), OCRAccessKeySecret: &firstSecret,
	})
	if err != nil || acc.OCRAccessKeyID == nil || *acc.OCRAccessKeyID != keyID {
		t.Fatalf("acc = %#v, %v", acc, err)
	}
	if raw, _ := json.Marshal(acc); strings.Contains(string(raw), "secret") || strings.Contains(string(raw), firstSecret) {
		t.Fatalf("财务设置响应泄漏密钥: %s", raw)
	}
	secondID := "second-key-id"
	if _, err := service.UpdateAccounting(ctx, actor, AccountingUpdate{OCRAccessKeyID: optionalString(&secondID)}); err != nil {
		t.Fatal(err)
	}
	var storedSecret *string
	if err := pool.QueryRow(ctx, "SELECT ocr_access_key_secret FROM acc_setting WHERE id=$1", acc.ID).Scan(&storedSecret); err != nil {
		t.Fatal(err)
	}
	if storedSecret == nil || *storedSecret != firstSecret {
		t.Fatalf("未传 secret 时应保留旧值，got %#v", storedSecret)
	}
	configured, err := service.OCRConfigured(ctx)
	if err != nil || !configured {
		t.Fatalf("ocr configured = %v, %v", configured, err)
	}

	enabled, settlement, interval := !originalSystem.MarketFetchScheduleEnabled, !originalSystem.MarketFetchSettlementEnabled, 30
	system, err := service.UpdateSystem(ctx, actor, SystemUpdate{
		MarketFetchScheduleEnabled:     &enabled,
		MarketFetchLastIntervalMinutes: &interval,
		MarketFetchSettlementEnabled:   &settlement,
	})
	if err != nil || system.MarketFetchLastIntervalMinutes != 30 {
		t.Fatalf("system = %#v, %v", system, err)
	}
	if err := service.RecordMarketFetch(ctx, actor, strings.Repeat("中", 600)); err != nil {
		t.Fatal(err)
	}
	system, err = service.GetSystem(ctx)
	if err != nil || system.MarketFetchLastRunAt == nil || system.MarketFetchLastSummary == nil ||
		len([]rune(*system.MarketFetchLastSummary)) != 500 {
		t.Fatalf("recorded system = %#v, %v", system, err)
	}

	var filtered string
	if err := pool.QueryRow(ctx, `
		SELECT changes->'ocr_access_key_secret'->>'to'
		FROM sys_audit_log
		WHERE resource='acc_setting' AND actor_id=$1
		  AND changes ? 'ocr_access_key_secret'
		ORDER BY inserted_at DESC LIMIT 1
	`, userID).Scan(&filtered); err != nil {
		t.Fatal(err)
	}
	if filtered != "[FILTERED]" {
		t.Fatalf("secret audit value = %q", filtered)
	}
	var leaked int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM sys_audit_log
		WHERE resource='acc_setting' AND actor_id=$1 AND changes::text LIKE '%' || $2 || '%'
	`, userID, firstSecret).Scan(&leaked); err != nil {
		t.Fatal(err)
	}
	if leaked != 0 {
		t.Fatalf("审计日志泄漏 OCR secret 明文 %d 行", leaked)
	}
	var companyScoped int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM sys_audit_log
		WHERE actor_id=$1 AND resource=ANY($2) AND company_id IS NOT NULL
	`, userID, []string{"sal_setting", "mfg_setting", "acc_setting", "sys_setting"}).Scan(&companyScoped); err != nil {
		t.Fatal(err)
	}
	if companyScoped != 0 {
		t.Fatalf("全局设置审计不应带 company_id，got %d", companyScoped)
	}
}

func optionalString(value *string) **string { return &value }

func errorCode(err error) apierror.Code {
	var coded *apierror.Error
	if errors.As(err, &coded) {
		return coded.Code
	}
	return ""
}

func readAccountingForRestore(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	service *Service,
) (AccountingSetting, *string) {
	t.Helper()
	value, err := service.GetAccounting(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var secret *string
	if err := pool.QueryRow(ctx, "SELECT ocr_access_key_secret FROM acc_setting WHERE id=$1", value.ID).Scan(&secret); err != nil {
		t.Fatal(err)
	}
	return value, secret
}

func restoreSettings(
	ctx context.Context,
	pool *pgxpool.Pool,
	sales SalesSetting,
	mfg ManufacturingSetting,
	acc AccountingSetting,
	secret *string,
	system SystemSetting,
) {
	_, _ = pool.Exec(ctx, `
		UPDATE sal_setting SET sample_item_max_qty=$2,delivery_overship_ratio=$3,
		  spot_item_max_qty=$4,receipt_overreceive_ratio=$5,demand_overorder_ratio=$6,
		  updated_at=$7 WHERE id=$1
	`, sales.ID, sales.SampleItemMaxQty, sales.DeliveryOvershipRatio, sales.SpotItemMaxQty,
		sales.ReceiptOverreceiveRatio, sales.DemandOverorderRatio, sales.UpdatedAt)
	_, _ = pool.Exec(ctx, `
		UPDATE mfg_setting SET output_overreceive_ratio=$2,updated_at=$3 WHERE id=$1
	`, mfg.ID, mfg.OutputOverreceiveRatio, mfg.UpdatedAt)
	_, _ = pool.Exec(ctx, `
		UPDATE acc_setting SET ocr_access_key_id=$2,ocr_access_key_secret=$3,updated_at=$4 WHERE id=$1
	`, acc.ID, acc.OCRAccessKeyID, secret, acc.UpdatedAt)
	_, _ = pool.Exec(ctx, `
		UPDATE sys_setting SET market_fetch_schedule_enabled=$2,
		  market_fetch_last_interval_minutes=$3,market_fetch_settlement_enabled=$4,
		  market_fetch_last_run_at=$5,market_fetch_last_summary=$6,updated_at=$7 WHERE id=$1
	`, system.ID, system.MarketFetchScheduleEnabled, system.MarketFetchLastIntervalMinutes,
		system.MarketFetchSettlementEnabled, system.MarketFetchLastRunAt,
		system.MarketFetchLastSummary, system.UpdatedAt)
}
