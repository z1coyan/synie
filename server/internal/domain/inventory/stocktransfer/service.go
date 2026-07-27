package stocktransfer

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/db/dbgen"
	"github.com/z1coyan/synie/server/internal/db/pgconv"
	"github.com/z1coyan/synie/server/internal/domain/inventory/stock"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/audit"
	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/platform/dberr"
	"github.com/z1coyan/synie/server/internal/platform/numbering"
)

const voucherType = "inv.stock_transfer"

type Numberer interface {
	NextInTx(context.Context, pgx.Tx, numbering.NextInput) (string, error)
}

type Service struct {
	pool     *pgxpool.Pool
	numberer Numberer
}

func NewService(pool *pgxpool.Pool, numberers ...Numberer) *Service {
	var numberer Numberer = numbering.NewService(pool)
	if len(numberers) > 0 && numberers[0] != nil {
		numberer = numberers[0]
	}
	return &Service{pool: pool, numberer: numberer}
}

func (s *Service) Get(ctx context.Context, actor *authz.Actor, id uuid.UUID) (Transfer, error) {
	if err := require(actor, "read"); err != nil {
		return Transfer{}, err
	}
	row, err := dbgen.New(s.pool).GetStockTransfer(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Transfer{}, apierror.New(apierror.CodeNotFound, "手工调拨单不存在")
	}
	if err != nil {
		return Transfer{}, apierror.Wrap(apierror.CodeInternal, "读取手工调拨单失败", err)
	}
	if !actor.CanAccessCompany(row.CompanyID) {
		return Transfer{}, apierror.New(apierror.CodeNotFound, "手工调拨单不存在")
	}
	return transferFromRow(row), nil
}

func (s *Service) Create(
	ctx context.Context,
	actor *authz.Actor,
	input CreateInput,
) (Transfer, error) {
	if err := require(actor, "create"); err != nil {
		return Transfer{}, err
	}
	if err := validateCreate(actor, input); err != nil {
		return Transfer{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Transfer{}, apierror.Wrap(apierror.CodeInternal, "创建手工调拨单失败", err)
	}
	defer tx.Rollback(ctx)
	q := dbgen.New(tx)
	if err := validateWarehouses(ctx, q, input.CompanyID, input.FromWarehouseID,
		input.ToWarehouseID, input.TransitWarehouseID, true); err != nil {
		return Transfer{}, err
	}
	docDate := todayUTC()
	if input.DocDate != nil {
		docDate = *input.DocDate
	}
	docNo := ""
	if input.DocNo != nil {
		docNo = strings.TrimSpace(*input.DocNo)
	}
	if docNo == "" {
		docNo, err = s.numberer.NextInTx(ctx, tx, numbering.NextInput{
			Resource: "inv.stock_transfer",
			Values:   map[string]any{"company_id": input.CompanyID, "doc_date": docDate},
		})
		if err != nil {
			return Transfer{}, err
		}
	}
	if utf8.RuneCountInString(docNo) > 32 {
		return Transfer{}, invalidTransfer(map[string][]string{"docNo": {"最多 32 个字符"}})
	}
	row, err := q.CreateStockTransfer(ctx, dbgen.CreateStockTransferParams{
		DocNo: docNo, DocDate: pgconv.Date(docDate), Summary: pgconv.Text(input.Summary),
		Remarks: pgconv.Text(input.Remarks), CompanyID: input.CompanyID,
		FromWarehouseID: input.FromWarehouseID, ToWarehouseID: input.ToWarehouseID,
		TransitWarehouseID: input.TransitWarehouseID, CreatedByID: actorID(actor),
	})
	if err != nil {
		return Transfer{}, writeError("创建手工调拨单失败", err)
	}
	item := transferFromRow(row)
	if err := writeTransferAudit(ctx, tx, actor, item, "create", "create",
		audit.Created(transferSnapshot(item), transferAuditedFields)); err != nil {
		return Transfer{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Transfer{}, writeError("创建手工调拨单失败", err)
	}
	return item, nil
}

func (s *Service) Update(
	ctx context.Context,
	actor *authz.Actor,
	id uuid.UUID,
	input UpdateInput,
) (Transfer, error) {
	if err := require(actor, "update"); err != nil {
		return Transfer{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Transfer{}, apierror.Wrap(apierror.CodeInternal, "更新手工调拨单失败", err)
	}
	defer tx.Rollback(ctx)
	q := dbgen.New(tx)
	row, err := q.LockStockTransfer(ctx, id)
	if err := lockError(err, "更新手工调拨单失败"); err != nil {
		return Transfer{}, err
	}
	before := transferFromRow(row)
	if err := requireCompany(actor, before.CompanyID); err != nil {
		return Transfer{}, err
	}
	if before.Status != StatusDraft {
		return Transfer{}, draftError()
	}
	after := before
	if input.DocNo != nil {
		after.DocNo = strings.TrimSpace(*input.DocNo)
	}
	if input.DocDate != nil {
		after.DocDate = *input.DocDate
	}
	if input.Summary != nil {
		after.Summary = *input.Summary
	}
	if input.Remarks != nil {
		after.Remarks = *input.Remarks
	}
	if input.FromWarehouseID != nil {
		after.FromWarehouseID = *input.FromWarehouseID
	}
	if input.ToWarehouseID != nil {
		after.ToWarehouseID = *input.ToWarehouseID
	}
	if input.TransitWarehouseID != nil {
		after.TransitWarehouseID = *input.TransitWarehouseID
	}
	if err := validateMutable(after); err != nil {
		return Transfer{}, err
	}
	if err := validateWarehouses(ctx, q, after.CompanyID, after.FromWarehouseID,
		after.ToWarehouseID, after.TransitWarehouseID, true); err != nil {
		return Transfer{}, err
	}
	changes := audit.Diff(transferSnapshot(before), transferSnapshot(after), transferAuditedFields)
	if len(changes) == 0 {
		if err := tx.Commit(ctx); err != nil {
			return Transfer{}, apierror.Wrap(apierror.CodeInternal, "更新手工调拨单失败", err)
		}
		return before, nil
	}
	updated, err := q.UpdateStockTransfer(ctx, dbgen.UpdateStockTransferParams{
		ID: id, DocNo: after.DocNo, DocDate: pgconv.Date(after.DocDate),
		Summary: pgconv.Text(after.Summary), Remarks: pgconv.Text(after.Remarks),
		FromWarehouseID: after.FromWarehouseID, ToWarehouseID: after.ToWarehouseID,
		TransitWarehouseID: after.TransitWarehouseID,
	})
	if err != nil {
		return Transfer{}, writeError("更新手工调拨单失败", err)
	}
	result := transferFromRow(updated)
	if err := writeTransferAudit(ctx, tx, actor, result, "update", "update", changes); err != nil {
		return Transfer{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Transfer{}, writeError("更新手工调拨单失败", err)
	}
	return result, nil
}

func (s *Service) Delete(ctx context.Context, actor *authz.Actor, id uuid.UUID) error {
	if err := require(actor, "delete"); err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除手工调拨单失败", err)
	}
	defer tx.Rollback(ctx)
	q := dbgen.New(tx)
	row, err := q.LockStockTransfer(ctx, id)
	if err := lockError(err, "删除手工调拨单失败"); err != nil {
		return err
	}
	item := transferFromRow(row)
	if err := requireCompany(actor, item.CompanyID); err != nil {
		return err
	}
	if item.Status != StatusDraft {
		return draftError()
	}
	if _, err := q.DeleteStockTransfer(ctx, id); err != nil {
		return writeError("删除手工调拨单失败", err)
	}
	if err := writeTransferAudit(ctx, tx, actor, item, "destroy", "destroy",
		audit.Destroyed(transferSnapshot(item), transferAuditedFields)); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return writeError("删除手工调拨单失败", err)
	}
	return nil
}

func (s *Service) Ship(
	ctx context.Context,
	actor *authz.Actor,
	id uuid.UUID,
) (Transfer, error) {
	if err := require(actor, "ship"); err != nil {
		return Transfer{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Transfer{}, apierror.Wrap(apierror.CodeInternal, "手工调拨单发货失败", err)
	}
	defer tx.Rollback(ctx)
	q := dbgen.New(tx)
	row, err := q.LockStockTransfer(ctx, id)
	if err := lockError(err, "手工调拨单发货失败"); err != nil {
		return Transfer{}, err
	}
	before := transferFromRow(row)
	if err := requireCompany(actor, before.CompanyID); err != nil {
		return Transfer{}, err
	}
	if before.Status != StatusDraft {
		return Transfer{}, apierror.New(apierror.CodeConflict, "仅草稿调拨单可发货")
	}
	items, err := q.ListStockTransferItems(ctx, id)
	if err != nil {
		return Transfer{}, apierror.Wrap(apierror.CodeInternal, "读取手工调拨单行失败", err)
	}
	if len(items) == 0 {
		return Transfer{}, apierror.New(apierror.CodeConflict, "发货前必须至少填写一行单据行")
	}
	if err := validateWarehouses(ctx, q, before.CompanyID, before.FromWarehouseID,
		before.ToWarehouseID, before.TransitWarehouseID, true); err != nil {
		return Transfer{}, err
	}
	lines := make([]stock.Line, 0, len(items)*2)
	for _, item := range items {
		lines = append(lines,
			stock.Line{WarehouseID: before.FromWarehouseID, MaterialID: item.MaterialID,
				Quantity: item.BaseQty.Neg(), Remarks: before.Summary},
			stock.Line{WarehouseID: before.TransitWarehouseID, MaterialID: item.MaterialID,
				Quantity: item.BaseQty, Remarks: before.Summary},
		)
	}
	if err := stock.Post(ctx, tx, voucher(before), lines); err != nil {
		return Transfer{}, err
	}
	now := time.Now().UTC()
	updated, err := q.ShipStockTransfer(ctx, dbgen.ShipStockTransferParams{
		ID: id, ShippedAt: pgconv.Timestamp(now), ShippedByID: actorID(actor),
	})
	if err != nil {
		return Transfer{}, apierror.Wrap(apierror.CodeInternal, "更新手工调拨单发货状态失败", err)
	}
	after := transferFromRow(updated)
	if err := writeTransferAudit(ctx, tx, actor, after, "update", "ship",
		audit.Diff(transferSnapshot(before), transferSnapshot(after), transferAuditedFields)); err != nil {
		return Transfer{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Transfer{}, writeError("手工调拨单发货失败", err)
	}
	return after, nil
}

func (s *Service) Receive(
	ctx context.Context,
	actor *authz.Actor,
	id uuid.UUID,
	input ReceiveInput,
) (Transfer, error) {
	if err := require(actor, "receive"); err != nil {
		return Transfer{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Transfer{}, apierror.Wrap(apierror.CodeInternal, "手工调拨单收货失败", err)
	}
	defer tx.Rollback(ctx)
	q := dbgen.New(tx)
	row, err := q.LockStockTransfer(ctx, id)
	if err := lockError(err, "手工调拨单收货失败"); err != nil {
		return Transfer{}, err
	}
	before := transferFromRow(row)
	if err := requireCompany(actor, before.CompanyID); err != nil {
		return Transfer{}, err
	}
	if before.Status != StatusShipped {
		return Transfer{}, apierror.New(apierror.CodeConflict, "仅已发货调拨单可收货")
	}
	items, err := q.ListStockTransferItems(ctx, id)
	if err != nil {
		return Transfer{}, apierror.Wrap(apierror.CodeInternal, "读取手工调拨单行失败", err)
	}
	resolved, err := resolveReceipts(items, input.Receipts)
	if err != nil {
		return Transfer{}, err
	}
	lines := make([]stock.Line, 0, len(resolved)*2)
	for _, receipt := range resolved {
		if receipt.qty.IsZero() {
			continue
		}
		lines = append(lines,
			stock.Line{WarehouseID: before.TransitWarehouseID, MaterialID: receipt.item.MaterialID,
				Quantity: receipt.qty.Neg(), Remarks: before.Summary},
			stock.Line{WarehouseID: before.ToWarehouseID, MaterialID: receipt.item.MaterialID,
				Quantity: receipt.qty, Remarks: before.Summary},
		)
	}
	if len(lines) > 0 {
		if err := stock.Post(ctx, tx, voucher(before), lines); err != nil {
			return Transfer{}, err
		}
	}
	for _, receipt := range resolved {
		beforeItem := itemFromRow(receipt.item)
		row, err := q.WriteStockTransferItemReceivedQty(
			ctx,
			dbgen.WriteStockTransferItemReceivedQtyParams{
				ID: receipt.item.ID, ReceivedQty: numeric(receipt.qty),
			},
		)
		if err != nil {
			return Transfer{}, apierror.Wrap(apierror.CodeInternal, "回写手工调拨单实收数量失败", err)
		}
		afterItem := itemFromRow(row)
		if err := writeItemAudit(ctx, tx, nil, afterItem, "update", "write_received",
			audit.Diff(itemSnapshot(beforeItem), itemSnapshot(afterItem), itemAuditedFields)); err != nil {
			return Transfer{}, err
		}
	}
	now := time.Now().UTC()
	updated, err := q.ReceiveStockTransfer(ctx, dbgen.ReceiveStockTransferParams{
		ID: id, ReceivedAt: pgconv.Timestamp(now), ReceivedByID: actorID(actor),
	})
	if err != nil {
		return Transfer{}, apierror.Wrap(apierror.CodeInternal, "更新手工调拨单收货状态失败", err)
	}
	after := transferFromRow(updated)
	if err := writeTransferAudit(ctx, tx, actor, after, "update", "receive",
		audit.Diff(transferSnapshot(before), transferSnapshot(after), transferAuditedFields)); err != nil {
		return Transfer{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Transfer{}, writeError("手工调拨单收货失败", err)
	}
	return after, nil
}

type resolvedReceipt struct {
	item dbgen.InvStockTransferItem
	qty  decimal.Decimal
}

func resolveReceipts(
	items []dbgen.InvStockTransferItem,
	receipts []Receipt,
) ([]resolvedReceipt, error) {
	if receipts == nil {
		result := make([]resolvedReceipt, 0, len(items))
		for _, item := range items {
			result = append(result, resolvedReceipt{item: item, qty: item.BaseQty})
		}
		return result, nil
	}
	given := make(map[uuid.UUID]decimal.Decimal, len(receipts))
	for _, receipt := range receipts {
		if _, duplicate := given[receipt.ItemID]; duplicate {
			return nil, apierror.New(apierror.CodeConflict, "实收行不得重复")
		}
		given[receipt.ItemID] = receipt.Qty
	}
	known := make(map[uuid.UUID]struct{}, len(items))
	for _, item := range items {
		known[item.ID] = struct{}{}
	}
	for id := range given {
		if _, ok := known[id]; !ok {
			return nil, apierror.New(apierror.CodeConflict, "实收行不属于本调拨单")
		}
	}
	result := make([]resolvedReceipt, 0, len(items))
	for _, item := range items {
		qty, ok := given[item.ID]
		if !ok {
			return nil, apierror.New(apierror.CodeConflict,
				fmt.Sprintf("收货数量必须覆盖全部行:第 %d 行缺实收数量", item.Idx))
		}
		if qty.IsNegative() || qty.GreaterThan(item.BaseQty) {
			return nil, apierror.New(apierror.CodeConflict,
				fmt.Sprintf("第 %d 行实收数量必须在 0 与发货数量 %s 之间",
					item.Idx, item.BaseQty.String()))
		}
		result = append(result, resolvedReceipt{item: item, qty: qty})
	}
	return result, nil
}

func validateCreate(actor *authz.Actor, input CreateInput) error {
	if input.CompanyID != uuid.Nil && !actor.CanAccessCompany(input.CompanyID) {
		return apierror.New(apierror.CodeForbidden, "无权操作该公司数据")
	}
	fields := map[string][]string{}
	if input.CompanyID == uuid.Nil {
		fields["companyId"] = []string{"必填"}
	}
	if input.FromWarehouseID == uuid.Nil {
		fields["fromWarehouseId"] = []string{"必填"}
	}
	if input.ToWarehouseID == uuid.Nil {
		fields["toWarehouseId"] = []string{"必填"}
	}
	if input.TransitWarehouseID == uuid.Nil {
		fields["transitWarehouseId"] = []string{"必填"}
	}
	if input.DocNo != nil && utf8.RuneCountInString(strings.TrimSpace(*input.DocNo)) > 32 {
		fields["docNo"] = []string{"最多 32 个字符"}
	}
	validateOptionalText(fields, "summary", input.Summary, 512)
	validateOptionalText(fields, "remarks", input.Remarks, 512)
	if len(fields) > 0 {
		return invalidTransfer(fields)
	}
	return validateDistinct(input.FromWarehouseID, input.ToWarehouseID, input.TransitWarehouseID)
}

func validateMutable(item Transfer) error {
	fields := map[string][]string{}
	if strings.TrimSpace(item.DocNo) == "" || utf8.RuneCountInString(item.DocNo) > 32 {
		fields["docNo"] = []string{"不能为空且最多 32 个字符"}
	}
	if item.DocDate.IsZero() {
		fields["docDate"] = []string{"必填"}
	}
	validateOptionalText(fields, "summary", item.Summary, 512)
	validateOptionalText(fields, "remarks", item.Remarks, 512)
	if len(fields) > 0 {
		return invalidTransfer(fields)
	}
	return validateDistinct(item.FromWarehouseID, item.ToWarehouseID, item.TransitWarehouseID)
}

func validateDistinct(fromID, toID, transitID uuid.UUID) error {
	if fromID == toID || fromID == transitID || toID == transitID {
		return invalidTransfer(map[string][]string{
			"transitWarehouseId": {"调出、调入与在途仓库必须两两不同"},
		})
	}
	return nil
}

func validateWarehouses(
	ctx context.Context,
	q *dbgen.Queries,
	companyID uuid.UUID,
	fromID uuid.UUID,
	toID uuid.UUID,
	transitID uuid.UUID,
	checkActive bool,
) error {
	if err := validateDistinct(fromID, toID, transitID); err != nil {
		return err
	}
	for _, id := range []uuid.UUID{fromID, toID, transitID} {
		row, err := q.GetWarehouse(ctx, id)
		if errors.Is(err, pgx.ErrNoRows) {
			return invalidTransfer(map[string][]string{"warehouseId": {"仓库不存在"}})
		}
		if err != nil {
			return apierror.Wrap(apierror.CodeInternal, "读取仓库失败", err)
		}
		switch {
		case row.CompanyID != companyID:
			return invalidTransfer(map[string][]string{"warehouseId": {"仓库不属于本公司"}})
		case !row.IsLeaf:
			return invalidTransfer(map[string][]string{"warehouseId": {"只有叶子仓库才能发生库存"}})
		case checkActive && !row.Active:
			return invalidTransfer(map[string][]string{"warehouseId": {"仓库已停用"}})
		}
	}
	return nil
}

func require(actor *authz.Actor, action string) error {
	if actor == nil || !actor.HasPermission("inv.stock_transfer:"+action) {
		return apierror.New(apierror.CodeForbidden, "无权执行手工调拨单操作")
	}
	return nil
}

func requireCompany(actor *authz.Actor, companyID uuid.UUID) error {
	if actor == nil || !actor.CanAccessCompany(companyID) {
		return apierror.New(apierror.CodeForbidden, "无权操作该公司数据")
	}
	return nil
}

func draftError() error {
	return apierror.New(apierror.CodeConflict, "仅草稿调拨单可修改或删除")
}

func lockError(err error, message string) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return apierror.New(apierror.CodeNotFound, "手工调拨单不存在")
	}
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, message, err)
	}
	return nil
}

var writeMappings = []dberr.Mapping{
	{Code: "23505", Message: "单据编号已存在"},
}

func writeError(message string, err error) error {
	return dberr.MapWrite(err, message, writeMappings...)
}

func invalidTransfer(fields map[string][]string) error {
	return apierror.Validation("手工调拨单参数不合法", fields)
}

func voucher(item Transfer) stock.Voucher {
	return stock.Voucher{
		Type: voucherType, ID: item.ID, No: item.DocNo,
		CompanyID: item.CompanyID, PostingDate: item.DocDate,
	}
}

func actorID(actor *authz.Actor) *uuid.UUID {
	if actor == nil || actor.UserID == uuid.Nil {
		return nil
	}
	return &actor.UserID
}

func writeTransferAudit(
	ctx context.Context,
	tx pgx.Tx,
	actor *authz.Actor,
	item Transfer,
	actionType string,
	actionName string,
	changes map[string]audit.Change,
) error {
	companyID := item.CompanyID
	if err := audit.Write(ctx, tx, actor, audit.Entry{
		Resource: "inv_stock_transfer", RecordID: item.ID, RecordLabel: item.DocNo,
		ActionType: actionType, ActionName: actionName, CompanyID: &companyID,
		Changes: changes,
	}); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "写入手工调拨单审计失败", err)
	}
	return nil
}

var transferAuditedFields = []string{
	"doc_no", "doc_date", "summary", "remarks", "status", "shipped_at", "received_at",
	"company_id", "from_warehouse_id", "to_warehouse_id", "transit_warehouse_id",
	"created_by_id", "shipped_by_id", "received_by_id",
}

func transferSnapshot(item Transfer) map[string]any {
	return map[string]any{
		"doc_no": item.DocNo, "doc_date": item.DocDate, "summary": item.Summary,
		"remarks": item.Remarks, "status": item.Status, "shipped_at": item.ShippedAt,
		"received_at": item.ReceivedAt, "company_id": item.CompanyID,
		"from_warehouse_id": item.FromWarehouseID, "to_warehouse_id": item.ToWarehouseID,
		"transit_warehouse_id": item.TransitWarehouseID, "created_by_id": item.CreatedByID,
		"shipped_by_id": item.ShippedByID, "received_by_id": item.ReceivedByID,
	}
}

func transferFromRow(row dbgen.InvStockTransfer) Transfer {
	return Transfer{
		ID: row.ID, DocNo: row.DocNo, DocDate: row.DocDate.Time,
		Summary: pgconv.TextPtr(row.Summary), Remarks: pgconv.TextPtr(row.Remarks),
		Status: Status(strings.ToUpper(row.Status)), ShippedAt: pgconv.OptionalTime(row.ShippedAt),
		ReceivedAt: pgconv.OptionalTime(row.ReceivedAt), InsertedAt: row.InsertedAt.Time.UTC(),
		UpdatedAt: row.UpdatedAt.Time.UTC(), CompanyID: row.CompanyID,
		FromWarehouseID: row.FromWarehouseID, ToWarehouseID: row.ToWarehouseID,
		TransitWarehouseID: row.TransitWarehouseID, CreatedByID: row.CreatedByID,
		ShippedByID: row.ShippedByID, ReceivedByID: row.ReceivedByID,
	}
}

func todayUTC() time.Time {
	now := time.Now().UTC()
	return time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
}

func validateOptionalText(fields map[string][]string, name string, value *string, max int) {
	if value != nil && utf8.RuneCountInString(*value) > max {
		fields[name] = []string{fmt.Sprintf("最多 %d 个字符", max)}
	}
}

func numeric(value decimal.Decimal) pgtype.Numeric {
	return pgtype.Numeric{
		Int: value.Coefficient(), Exp: value.Exponent(),
		Valid: true, InfinityModifier: pgtype.Finite,
	}
}
