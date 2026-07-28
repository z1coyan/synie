package settings

import (
	"context"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/db/dbgen"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/audit"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

var (
	salesAuditFields = []string{
		"sample_item_max_qty", "delivery_overship_ratio", "spot_item_max_qty",
		"receipt_overreceive_ratio", "demand_overorder_ratio",
	}
	manufacturingAuditFields = []string{"output_overreceive_ratio"}
	accountingAuditFields    = []string{"ocr_access_key_id", "ocr_access_key_secret"}
	systemAuditFields        = []string{
		"market_fetch_schedule_enabled", "market_fetch_last_interval_minutes",
		"market_fetch_settlement_enabled",
	}
	systemRunAuditFields = []string{"market_fetch_last_run_at", "market_fetch_last_summary"}
)

type Service struct {
	pool    *pgxpool.Pool
	queries *dbgen.Queries
}

func NewService(pool *pgxpool.Pool) *Service {
	return &Service{pool: pool, queries: dbgen.New(pool)}
}

func (s *Service) GetSales(ctx context.Context) (SalesSetting, error) {
	row, err := s.queries.GetSalesSetting(ctx)
	if err != nil {
		return SalesSetting{}, settingReadError("供应链设置", err)
	}
	return salesFromGet(row), nil
}

func (s *Service) GetManufacturing(ctx context.Context) (ManufacturingSetting, error) {
	row, err := s.queries.GetManufacturingSetting(ctx)
	if err != nil {
		return ManufacturingSetting{}, settingReadError("生产设置", err)
	}
	return manufacturingFromDB(row), nil
}

func (s *Service) GetAccounting(ctx context.Context) (AccountingSetting, error) {
	row, err := s.queries.GetAccountingSetting(ctx)
	if err != nil {
		return AccountingSetting{}, settingReadError("财务设置", err)
	}
	return accountingFromGet(row), nil
}

func (s *Service) GetSystem(ctx context.Context) (SystemSetting, error) {
	row, err := s.queries.GetSystemSetting(ctx)
	if err != nil {
		return SystemSetting{}, settingReadError("系统设置", err)
	}
	return systemFromGet(row), nil
}

func (s *Service) OCRConfigured(ctx context.Context) (bool, error) {
	row, err := s.queries.GetAccountingSettingInternal(ctx)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, apierror.Wrap(apierror.CodeInternal, "读取 OCR 配置状态失败", err)
	}
	return row.OcrAccessKeyID.Valid && strings.TrimSpace(row.OcrAccessKeyID.String) != "" &&
		row.OcrAccessKeySecret.Valid && strings.TrimSpace(row.OcrAccessKeySecret.String) != "", nil
}

func (s *Service) UpdateSales(
	ctx context.Context,
	actor *authz.Actor,
	input SalesUpdate,
) (SalesSetting, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return SalesSetting{}, apierror.Wrap(apierror.CodeInternal, "更新供应链设置失败", err)
	}
	defer tx.Rollback(ctx)
	q := dbgen.New(tx)
	row, err := q.LockSalesSetting(ctx)
	if err != nil {
		return SalesSetting{}, settingReadError("供应链设置", err)
	}
	before := salesFromLock(row)
	after := before
	if input.SampleItemMaxQty != nil {
		after.SampleItemMaxQty = *input.SampleItemMaxQty
	}
	if input.DeliveryOvershipRatio != nil {
		after.DeliveryOvershipRatio = *input.DeliveryOvershipRatio
	}
	if input.SpotItemMaxQty != nil {
		after.SpotItemMaxQty = *input.SpotItemMaxQty
	}
	if input.ReceiptOverreceiveRatio != nil {
		after.ReceiptOverreceiveRatio = *input.ReceiptOverreceiveRatio
	}
	if input.DemandOverorderRatio != nil {
		after.DemandOverorderRatio = *input.DemandOverorderRatio
	}
	if err := validateSales(after); err != nil {
		return SalesSetting{}, err
	}
	changes := audit.Diff(salesSnapshot(before), salesSnapshot(after), salesAuditFields)
	if len(changes) == 0 {
		return before, commitUnchanged(ctx, tx, "更新供应链设置失败")
	}
	updated, err := q.UpdateSalesSetting(ctx, dbgen.UpdateSalesSettingParams{
		ID: after.ID, SampleItemMaxQty: after.SampleItemMaxQty,
		DeliveryOvershipRatio:   after.DeliveryOvershipRatio,
		SpotItemMaxQty:          after.SpotItemMaxQty,
		ReceiptOverreceiveRatio: after.ReceiptOverreceiveRatio,
		DemandOverorderRatio:    after.DemandOverorderRatio,
	})
	if err != nil {
		return SalesSetting{}, apierror.Wrap(apierror.CodeInternal, "更新供应链设置失败", err)
	}
	result := salesFromUpdate(updated)
	if err := writeSettingAudit(ctx, tx, actor, "sal_setting", result.ID, "update", changes); err != nil {
		return SalesSetting{}, apierror.Wrap(apierror.CodeInternal, "更新供应链设置失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return SalesSetting{}, apierror.Wrap(apierror.CodeInternal, "更新供应链设置失败", err)
	}
	return result, nil
}

func (s *Service) UpdateManufacturing(
	ctx context.Context,
	actor *authz.Actor,
	input ManufacturingUpdate,
) (ManufacturingSetting, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ManufacturingSetting{}, apierror.Wrap(apierror.CodeInternal, "更新生产设置失败", err)
	}
	defer tx.Rollback(ctx)
	q := dbgen.New(tx)
	row, err := q.LockManufacturingSetting(ctx)
	if err != nil {
		return ManufacturingSetting{}, settingReadError("生产设置", err)
	}
	before := manufacturingFromDB(row)
	after := before
	if input.OutputOverreceiveRatio != nil {
		after.OutputOverreceiveRatio = *input.OutputOverreceiveRatio
	}
	if err := validateRatio("outputOverreceiveRatio", "生产入库超入比例", after.OutputOverreceiveRatio); err != nil {
		return ManufacturingSetting{}, err
	}
	changes := audit.Diff(manufacturingSnapshot(before), manufacturingSnapshot(after), manufacturingAuditFields)
	if len(changes) == 0 {
		return before, commitUnchanged(ctx, tx, "更新生产设置失败")
	}
	updated, err := q.UpdateManufacturingSetting(ctx, dbgen.UpdateManufacturingSettingParams{
		ID: after.ID, OutputOverreceiveRatio: after.OutputOverreceiveRatio,
	})
	if err != nil {
		return ManufacturingSetting{}, apierror.Wrap(apierror.CodeInternal, "更新生产设置失败", err)
	}
	result := manufacturingFromDB(updated)
	if err := writeSettingAudit(ctx, tx, actor, "mfg_setting", result.ID, "update", changes); err != nil {
		return ManufacturingSetting{}, apierror.Wrap(apierror.CodeInternal, "更新生产设置失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return ManufacturingSetting{}, apierror.Wrap(apierror.CodeInternal, "更新生产设置失败", err)
	}
	return result, nil
}

func (s *Service) UpdateAccounting(
	ctx context.Context,
	actor *authz.Actor,
	input AccountingUpdate,
) (AccountingSetting, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return AccountingSetting{}, apierror.Wrap(apierror.CodeInternal, "更新财务设置失败", err)
	}
	defer tx.Rollback(ctx)
	q := dbgen.New(tx)
	row, err := q.LockAccountingSetting(ctx)
	if err != nil {
		return AccountingSetting{}, settingReadError("财务设置", err)
	}
	before := accountingFromDB(row)
	keyID := textPtr(row.OcrAccessKeyID)
	secret := textPtr(row.OcrAccessKeySecret)
	if input.OCRAccessKeyID != nil {
		keyID = *input.OCRAccessKeyID
	}
	if input.OCRAccessKeySecret != nil && *input.OCRAccessKeySecret != "" {
		secret = input.OCRAccessKeySecret
	}
	if keyID != nil && utf8.RuneCountInString(*keyID) > 128 {
		return AccountingSetting{}, apierror.Validation("OCR AccessKey ID 不能超过 128 个字符",
			map[string][]string{"ocrAccessKeyId": {"不能超过 128 个字符"}})
	}
	if secret != nil && utf8.RuneCountInString(*secret) > 128 {
		return AccountingSetting{}, apierror.Validation("OCR AccessKey Secret 不能超过 128 个字符",
			map[string][]string{"ocrAccessKeySecret": {"不能超过 128 个字符"}})
	}
	after := AccountingSetting{
		ID: row.ID, OCRAccessKeyID: keyID,
		InsertedAt: row.InsertedAt.Time.UTC(), UpdatedAt: row.UpdatedAt.Time.UTC(),
	}
	beforeSnapshot := accountingSnapshot(before, textPtr(row.OcrAccessKeySecret))
	afterSnapshot := accountingSnapshot(after, secret)
	changes := audit.Diff(beforeSnapshot, afterSnapshot, accountingAuditFields)
	if len(changes) == 0 {
		return before, commitUnchanged(ctx, tx, "更新财务设置失败")
	}
	updated, err := q.UpdateAccountingSetting(ctx, dbgen.UpdateAccountingSettingParams{
		ID: row.ID, OcrAccessKeyID: text(keyID), OcrAccessKeySecret: text(secret),
	})
	if err != nil {
		return AccountingSetting{}, apierror.Wrap(apierror.CodeInternal, "更新财务设置失败", err)
	}
	result := accountingFromDB(updated)
	if err := writeSettingAudit(ctx, tx, actor, "acc_setting", result.ID, "update", changes); err != nil {
		return AccountingSetting{}, apierror.Wrap(apierror.CodeInternal, "更新财务设置失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return AccountingSetting{}, apierror.Wrap(apierror.CodeInternal, "更新财务设置失败", err)
	}
	return result, nil
}

func (s *Service) UpdateSystem(
	ctx context.Context,
	actor *authz.Actor,
	input SystemUpdate,
) (SystemSetting, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return SystemSetting{}, apierror.Wrap(apierror.CodeInternal, "更新系统设置失败", err)
	}
	defer tx.Rollback(ctx)
	q := dbgen.New(tx)
	row, err := q.LockSystemSetting(ctx)
	if err != nil {
		return SystemSetting{}, settingReadError("系统设置", err)
	}
	before := systemFromLock(row)
	after := before
	if input.MarketFetchScheduleEnabled != nil {
		after.MarketFetchScheduleEnabled = *input.MarketFetchScheduleEnabled
	}
	if input.MarketFetchLastIntervalMinutes != nil {
		after.MarketFetchLastIntervalMinutes = *input.MarketFetchLastIntervalMinutes
	}
	if input.MarketFetchSettlementEnabled != nil {
		after.MarketFetchSettlementEnabled = *input.MarketFetchSettlementEnabled
	}
	if after.MarketFetchLastIntervalMinutes != 30 &&
		after.MarketFetchLastIntervalMinutes != 60 &&
		after.MarketFetchLastIntervalMinutes != 120 {
		return SystemSetting{}, apierror.Validation("最新价拉取间隔仅允许 30/60/120 分钟",
			map[string][]string{"marketFetchLastIntervalMinutes": {"仅允许 30、60 或 120"}})
	}
	changes := audit.Diff(systemSnapshot(before), systemSnapshot(after), systemAuditFields)
	if len(changes) == 0 {
		return before, commitUnchanged(ctx, tx, "更新系统设置失败")
	}
	updated, err := q.UpdateSystemSetting(ctx, dbgen.UpdateSystemSettingParams{
		ID:                             after.ID,
		MarketFetchScheduleEnabled:     after.MarketFetchScheduleEnabled,
		MarketFetchLastIntervalMinutes: int32(after.MarketFetchLastIntervalMinutes),
		MarketFetchSettlementEnabled:   after.MarketFetchSettlementEnabled,
	})
	if err != nil {
		return SystemSetting{}, apierror.Wrap(apierror.CodeInternal, "更新系统设置失败", err)
	}
	result := systemFromUpdate(updated)
	if err := writeSettingAudit(ctx, tx, actor, "sys_setting", result.ID, "update", changes); err != nil {
		return SystemSetting{}, apierror.Wrap(apierror.CodeInternal, "更新系统设置失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return SystemSetting{}, apierror.Wrap(apierror.CodeInternal, "更新系统设置失败", err)
	}
	return result, nil
}

func (s *Service) RecordMarketFetch(ctx context.Context, actor *authz.Actor, summary string) error {
	runes := []rune(summary)
	if len(runes) > 500 {
		summary = string(runes[:500])
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "记录行情拉取结果失败", err)
	}
	defer tx.Rollback(ctx)
	q := dbgen.New(tx)
	row, err := q.LockSystemSetting(ctx)
	if errors.Is(err, pgx.ErrNoRows) {
		return commitUnchanged(ctx, tx, "记录行情拉取结果失败")
	}
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "记录行情拉取结果失败", err)
	}
	before := systemFromLock(row)
	updated, err := q.RecordMarketFetch(ctx, dbgen.RecordMarketFetchParams{
		ID: row.ID, Summary: pgtype.Text{String: summary, Valid: true},
	})
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "记录行情拉取结果失败", err)
	}
	after := systemFromRecord(updated)
	changes := audit.Diff(systemRunSnapshot(before), systemRunSnapshot(after), systemRunAuditFields)
	if len(changes) > 0 {
		if err := writeSettingAudit(ctx, tx, actor, "sys_setting", after.ID, "record_market_fetch", changes); err != nil {
			return apierror.Wrap(apierror.CodeInternal, "记录行情拉取结果失败", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "记录行情拉取结果失败", err)
	}
	return nil
}

func validateSales(value SalesSetting) error {
	if value.SampleItemMaxQty <= 0 {
		return apierror.Validation("样品条目数量上限必须大于零",
			map[string][]string{"sampleItemMaxQty": {"必须大于零"}})
	}
	if value.SpotItemMaxQty <= 0 {
		return apierror.Validation("零星条目数量上限必须大于零",
			map[string][]string{"spotItemMaxQty": {"必须大于零"}})
	}
	if err := validateRatio("deliveryOvershipRatio", "发货超发比例", value.DeliveryOvershipRatio); err != nil {
		return err
	}
	if err := validateRatio("receiptOverreceiveRatio", "入库超收比例", value.ReceiptOverreceiveRatio); err != nil {
		return err
	}
	return validateRatio("demandOverorderRatio", "需求超下单比例", value.DemandOverorderRatio)
}

func validateRatio(field string, label string, value decimal.Decimal) error {
	if value.IsNegative() || value.GreaterThan(decimal.NewFromInt(1)) {
		return apierror.Validation(label+"须在 0 到 1 之间",
			map[string][]string{field: {"须在 0 到 1 之间"}})
	}
	return nil
}

func settingReadError(label string, err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return apierror.New(apierror.CodeNotFound, label+"不存在")
	}
	return apierror.Wrap(apierror.CodeInternal, "读取"+label+"失败", err)
}

func commitUnchanged(ctx context.Context, tx pgx.Tx, message string) error {
	if err := tx.Commit(ctx); err != nil {
		return apierror.Wrap(apierror.CodeInternal, message, err)
	}
	return nil
}

func writeSettingAudit(
	ctx context.Context,
	tx pgx.Tx,
	actor *authz.Actor,
	resource string,
	recordID uuid.UUID,
	actionName string,
	changes map[string]audit.Change,
) error {
	return audit.Write(ctx, tx, actor, audit.Entry{
		Resource: resource, RecordID: recordID,
		ActionType: "update", ActionName: actionName, Changes: changes,
		SensitiveFields: sensitiveAuditFields(resource),
	})
}

// sensitiveAuditFields 按表名从本包资源 meta 取声明的敏感字段，
// 新增敏感字段只需在对应 ResourceMeta 的 Audit.SensitiveFields 中声明即自动脱敏。
func sensitiveAuditFields(resource string) []string {
	for _, resourceMeta := range ResourceMetas() {
		if resourceMeta.Table == resource {
			return resourceMeta.Audit.SensitiveFields
		}
	}
	return nil
}

func salesSnapshot(value SalesSetting) map[string]any {
	return map[string]any{
		"sample_item_max_qty":       value.SampleItemMaxQty,
		"delivery_overship_ratio":   value.DeliveryOvershipRatio.String(),
		"spot_item_max_qty":         value.SpotItemMaxQty,
		"receipt_overreceive_ratio": value.ReceiptOverreceiveRatio.String(),
		"demand_overorder_ratio":    value.DemandOverorderRatio.String(),
	}
}

func manufacturingSnapshot(value ManufacturingSetting) map[string]any {
	return map[string]any{"output_overreceive_ratio": value.OutputOverreceiveRatio.String()}
}

func accountingSnapshot(value AccountingSetting, secret *string) map[string]any {
	return map[string]any{"ocr_access_key_id": stringValue(value.OCRAccessKeyID), "ocr_access_key_secret": stringValue(secret)}
}

func systemSnapshot(value SystemSetting) map[string]any {
	return map[string]any{
		"market_fetch_schedule_enabled":      value.MarketFetchScheduleEnabled,
		"market_fetch_last_interval_minutes": value.MarketFetchLastIntervalMinutes,
		"market_fetch_settlement_enabled":    value.MarketFetchSettlementEnabled,
	}
}

func systemRunSnapshot(value SystemSetting) map[string]any {
	var runAt any
	if value.MarketFetchLastRunAt != nil {
		runAt = value.MarketFetchLastRunAt.Format("2006-01-02T15:04:05Z07:00")
	}
	return map[string]any{
		"market_fetch_last_run_at":  runAt,
		"market_fetch_last_summary": stringValue(value.MarketFetchLastSummary),
	}
}

func stringValue(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}

func text(value *string) pgtype.Text {
	if value == nil {
		return pgtype.Text{}
	}
	return pgtype.Text{String: *value, Valid: true}
}

func textPtr(value pgtype.Text) *string {
	if !value.Valid {
		return nil
	}
	result := value.String
	return &result
}

func timestampPtr(value pgtype.Timestamp) *time.Time {
	if !value.Valid {
		return nil
	}
	result := value.Time.UTC()
	return &result
}
