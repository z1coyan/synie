package stock

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/db/dbgen"
	"github.com/z1coyan/synie/server/internal/db/pgconv"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
)

type balanceKey struct {
	warehouseID uuid.UUID
	materialID  uuid.UUID
}

type warehouse struct {
	name          string
	companyID     uuid.UUID
	isLeaf        bool
	allowNegative bool
}

type material struct {
	name string
}

// Post appends one fact per supplied line. The caller owns tx; this module
// never starts or commits a transaction.
func Post(ctx context.Context, tx pgx.Tx, voucher Voucher, lines []Line) error {
	if err := validateVoucher(voucher); err != nil {
		return err
	}
	if len(lines) == 0 {
		return apierror.Validation("库存过账校验失败", map[string][]string{
			"lines": {"分录不少于一行"},
		})
	}
	for i, line := range lines {
		if line.Quantity.IsZero() {
			return apierror.Validation("库存过账校验失败", map[string][]string{
				fmt.Sprintf("lines.%d.quantity", i): {"数量不能为零"},
			})
		}
	}

	q := dbgen.New(tx)
	warehouses, materials, err := loadReferences(ctx, q, voucher.CompanyID, lines, true)
	if err != nil {
		return err
	}
	deltas := group(lines)
	if err := lockAndCheck(ctx, q, deltas, warehouses, materials); err != nil {
		return err
	}

	for _, line := range lines {
		_, err := q.InsertStockEntry(ctx, dbgen.InsertStockEntryParams{
			CompanyID: voucher.CompanyID, WarehouseID: line.WarehouseID,
			MaterialID: line.MaterialID, Quantity: line.Quantity,
			PostingDate: pgconv.Date(voucher.PostingDate), VoucherType: voucher.Type,
			VoucherID: voucher.ID, VoucherNo: voucher.No, Remarks: pgconv.Text(line.Remarks),
		})
		if err != nil {
			return apierror.Wrap(apierror.CodeInternal, "写入库存分录失败", err)
		}
	}
	return nil
}

// Cancel marks all currently-live facts for a voucher as cancelled. It is
// idempotent. The caller owns tx.
func Cancel(ctx context.Context, tx pgx.Tx, ref VoucherRef, cancelledAt time.Time) error {
	if strings.TrimSpace(ref.Type) == "" || ref.ID == uuid.Nil {
		return apierror.Validation("库存作废参数不合法", map[string][]string{
			"voucher": {"来源单据类型和 ID 必填"},
		})
	}
	q := dbgen.New(tx)
	initial, err := q.ListLiveStockEntriesForVoucher(
		ctx,
		dbgen.ListLiveStockEntriesForVoucherParams{VoucherType: ref.Type, VoucherID: ref.ID},
	)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "读取待作废库存分录失败", err)
	}
	if len(initial) == 0 {
		return nil
	}

	keys := make([]balanceKey, 0, len(initial))
	seen := make(map[balanceKey]struct{}, len(initial))
	for _, entry := range initial {
		key := balanceKey{warehouseID: entry.WarehouseID, materialID: entry.MaterialID}
		if _, ok := seen[key]; !ok {
			seen[key] = struct{}{}
			keys = append(keys, key)
		}
	}
	sortKeys(keys)
	for _, key := range keys {
		if err := q.LockStockBalanceKey(ctx, lockKey(key)); err != nil {
			return apierror.Wrap(apierror.CodeInternal, "锁定库存余额失败", err)
		}
	}

	// A concurrent cancellation may have completed while this transaction was
	// waiting for a balance lock. Reload after locking to preserve idempotency.
	live, err := q.ListLiveStockEntriesForVoucher(
		ctx,
		dbgen.ListLiveStockEntriesForVoucherParams{VoucherType: ref.Type, VoucherID: ref.ID},
	)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "重读待作废库存分录失败", err)
	}
	if len(live) == 0 {
		return nil
	}

	lines := make([]Line, 0, len(live))
	companyID := live[0].CompanyID
	for _, entry := range live {
		lines = append(lines, Line{
			WarehouseID: entry.WarehouseID,
			MaterialID:  entry.MaterialID,
			Quantity:    entry.Quantity.Neg(),
		})
	}
	warehouses, materials, err := loadReferences(ctx, q, companyID, lines, false)
	if err != nil {
		return err
	}
	if err := checkLockedBalances(ctx, q, group(lines), warehouses, materials); err != nil {
		return err
	}
	if cancelledAt.IsZero() {
		cancelledAt = time.Now().UTC()
	}
	if _, err := q.CancelStockEntriesForVoucher(ctx, dbgen.CancelStockEntriesForVoucherParams{
		VoucherType: ref.Type, VoucherID: ref.ID, CancelledAt: pgconv.Timestamp(cancelledAt),
	}); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "作废库存分录失败", err)
	}
	return nil
}

func Balance(ctx context.Context, db dbgen.DBTX, query BalanceQuery) ([]BalanceRow, error) {
	if query.CompanyID == uuid.Nil {
		return nil, apierror.Validation("库存余额参数不合法", map[string][]string{
			"companyId": {"公司必填"},
		})
	}
	if query.AsOf.IsZero() {
		now := time.Now()
		query.AsOf = time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	}
	rows, err := dbgen.New(db).StockBalance(ctx, dbgen.StockBalanceParams{
		CompanyID: query.CompanyID, AsOf: pgconv.Date(query.AsOf),
		WarehouseID: query.WarehouseID, MaterialID: query.MaterialID,
		HideZero: query.HideZero,
	})
	if err != nil {
		return nil, apierror.Wrap(apierror.CodeInternal, "查询库存余额失败", err)
	}
	result := make([]BalanceRow, 0, len(rows))
	for _, row := range rows {
		result = append(result, BalanceRow{
			WarehouseID: row.WarehouseID, WarehouseName: row.WarehouseName,
			MaterialID: row.MaterialID, MaterialCode: row.MaterialCode,
			MaterialName: row.MaterialName, MaterialSpec: pgconv.TextPtr(row.MaterialSpec),
			UnitName: row.UnitName, Quantity: row.Quantity,
		})
	}
	return result, nil
}

func validateVoucher(voucher Voucher) error {
	fields := map[string][]string{}
	if strings.TrimSpace(voucher.Type) == "" || len(voucher.Type) > 64 {
		fields["voucherType"] = []string{"必填且最多 64 个字符"}
	}
	if voucher.ID == uuid.Nil {
		fields["voucherId"] = []string{"必填"}
	}
	if strings.TrimSpace(voucher.No) == "" || len(voucher.No) > 64 {
		fields["voucherNo"] = []string{"必填且最多 64 个字符"}
	}
	if voucher.CompanyID == uuid.Nil {
		fields["companyId"] = []string{"必填"}
	}
	if voucher.PostingDate.IsZero() {
		fields["postingDate"] = []string{"必填"}
	}
	if len(fields) > 0 {
		return apierror.Validation("库存过账参数不合法", fields)
	}
	return nil
}

func loadReferences(
	ctx context.Context,
	q *dbgen.Queries,
	companyID uuid.UUID,
	lines []Line,
	checkCompany bool,
) (map[uuid.UUID]warehouse, map[uuid.UUID]material, error) {
	warehouseIDs := uniqueIDs(lines, func(line Line) uuid.UUID { return line.WarehouseID })
	materialIDs := uniqueIDs(lines, func(line Line) uuid.UUID { return line.MaterialID })
	warehouseRows, err := q.GetStockWarehouses(ctx, warehouseIDs)
	if err != nil {
		return nil, nil, apierror.Wrap(apierror.CodeInternal, "读取库存仓库失败", err)
	}
	materialRows, err := q.GetStockMaterials(ctx, materialIDs)
	if err != nil {
		return nil, nil, apierror.Wrap(apierror.CodeInternal, "读取库存物料失败", err)
	}
	warehouses := make(map[uuid.UUID]warehouse, len(warehouseRows))
	for _, row := range warehouseRows {
		warehouses[row.ID] = warehouse{
			name: row.Name, companyID: row.CompanyID,
			isLeaf: row.IsLeaf, allowNegative: row.AllowNegative,
		}
	}
	materials := make(map[uuid.UUID]material, len(materialRows))
	for _, row := range materialRows {
		materials[row.ID] = material{name: row.Name}
	}
	for _, id := range warehouseIDs {
		item, ok := warehouses[id]
		if !ok {
			return nil, nil, apierror.Validation("库存过账校验失败", map[string][]string{
				"warehouseId": {"仓库不存在"},
			})
		}
		if checkCompany && item.companyID != companyID {
			return nil, nil, apierror.Validation("库存过账校验失败", map[string][]string{
				"warehouseId": {"仓库必须属于单据公司"},
			})
		}
		if !item.isLeaf {
			return nil, nil, apierror.Validation("库存过账校验失败", map[string][]string{
				"warehouseId": {"只有叶子仓库才能发生库存"},
			})
		}
	}
	for _, id := range materialIDs {
		if _, ok := materials[id]; !ok {
			return nil, nil, apierror.Validation("库存过账校验失败", map[string][]string{
				"materialId": {"物料不存在"},
			})
		}
	}
	return warehouses, materials, nil
}

func lockAndCheck(
	ctx context.Context,
	q *dbgen.Queries,
	deltas map[balanceKey]decimal.Decimal,
	warehouses map[uuid.UUID]warehouse,
	materials map[uuid.UUID]material,
) error {
	keys := mapKeys(deltas)
	sortKeys(keys)
	for _, key := range keys {
		if err := q.LockStockBalanceKey(ctx, lockKey(key)); err != nil {
			return apierror.Wrap(apierror.CodeInternal, "锁定库存余额失败", err)
		}
	}
	return checkLockedBalances(ctx, q, deltas, warehouses, materials)
}

func checkLockedBalances(
	ctx context.Context,
	q *dbgen.Queries,
	deltas map[balanceKey]decimal.Decimal,
	warehouses map[uuid.UUID]warehouse,
	materials map[uuid.UUID]material,
) error {
	keys := mapKeys(deltas)
	sortKeys(keys)
	for _, key := range keys {
		item := warehouses[key.warehouseID]
		if item.allowNegative {
			continue
		}
		current, err := q.CurrentStockBalance(ctx, dbgen.CurrentStockBalanceParams{
			WarehouseID: key.warehouseID, MaterialID: key.materialID,
		})
		if err != nil {
			return apierror.Wrap(apierror.CodeInternal, "读取当前库存余额失败", err)
		}
		delta := deltas[key]
		if current.Add(delta).IsNegative() {
			return apierror.New(
				apierror.CodeConflict,
				fmt.Sprintf(
					"仓「%s」物料「%s」库存不足:当前余额 %s,本次变动 %s",
					item.name, materials[key.materialID].name,
					current.String(), delta.String(),
				),
			)
		}
	}
	return nil
}

func group(lines []Line) map[balanceKey]decimal.Decimal {
	result := make(map[balanceKey]decimal.Decimal)
	for _, line := range lines {
		key := balanceKey{warehouseID: line.WarehouseID, materialID: line.MaterialID}
		result[key] = result[key].Add(line.Quantity)
	}
	return result
}

func uniqueIDs(lines []Line, selectID func(Line) uuid.UUID) []uuid.UUID {
	seen := make(map[uuid.UUID]struct{}, len(lines))
	result := make([]uuid.UUID, 0, len(lines))
	for _, line := range lines {
		id := selectID(line)
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		result = append(result, id)
	}
	return result
}

func mapKeys(values map[balanceKey]decimal.Decimal) []balanceKey {
	result := make([]balanceKey, 0, len(values))
	for key := range values {
		result = append(result, key)
	}
	return result
}

func sortKeys(keys []balanceKey) {
	sort.Slice(keys, func(i, j int) bool {
		left, right := lockKey(keys[i]), lockKey(keys[j])
		return left < right
	})
}

func lockKey(key balanceKey) string {
	return "inv_stock:" + key.warehouseID.String() + ":" + key.materialID.String()
}

func isNoRows(err error) bool {
	return errors.Is(err, pgx.ErrNoRows)
}
