package stockcount

import (
	"context"
	"fmt"
	"sort"
	"time"

	"github.com/google/uuid"
	"github.com/z1coyan/synie/server/internal/db/dbgen"
	"github.com/z1coyan/synie/server/internal/db/pgconv"
	"github.com/z1coyan/synie/server/internal/domain/inventory/stock"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/audit"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

func (s *Service) Refresh(
	ctx context.Context,
	actor *authz.Actor,
	id uuid.UUID,
) (Count, error) {
	if err := require(actor, "update"); err != nil {
		return Count{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Count{}, apierror.Wrap(apierror.CodeInternal, "刷新库存盘点单失败", err)
	}
	defer tx.Rollback(ctx)
	q := dbgen.New(tx)
	row, err := q.LockStockCount(ctx, id)
	if err := lockCountError(err, "锁定库存盘点单失败"); err != nil {
		return Count{}, err
	}
	before := countFromRow(row)
	if err := requireCompany(actor, before.CompanyID); err != nil {
		return Count{}, err
	}
	if before.Status != StatusDraft {
		return Count{}, apierror.New(apierror.CodeConflict, "仅草稿库存盘点单可刷新账面数量")
	}
	items, err := q.ListStockCountItems(ctx, id)
	if err != nil {
		return Count{}, apierror.Wrap(apierror.CodeInternal, "读取库存盘点单行失败", err)
	}
	snapshotTakenAt := time.Now().UTC()
	for _, raw := range items {
		current, balanceErr := q.CurrentStockBalance(
			ctx,
			dbgen.CurrentStockBalanceParams{
				WarehouseID: before.WarehouseID, MaterialID: raw.MaterialID,
			},
		)
		if balanceErr != nil {
			return Count{}, apierror.Wrap(apierror.CodeInternal, "读取账面数量失败", balanceErr)
		}
		beforeItem := itemFromRow(raw)
		updated, updateErr := q.SyncStockCountItemBookQuantity(
			ctx,
			dbgen.SyncStockCountItemBookQuantityParams{
				ID: raw.ID, BookQuantity: current,
			},
		)
		if updateErr != nil {
			return Count{}, apierror.Wrap(apierror.CodeInternal, "刷新库存盘点单行失败", updateErr)
		}
		afterItem := itemFromRow(updated)
		changes := audit.Diff(
			itemSnapshot(beforeItem), itemSnapshot(afterItem), itemAuditedFields,
		)
		if len(changes) > 0 {
			if err := writeItemAudit(
				ctx, tx, actor, afterItem, "update", "sync_book_quantity", changes,
			); err != nil {
				return Count{}, err
			}
		}
	}
	updated, err := q.TouchStockCountSnapshot(
		ctx,
		dbgen.TouchStockCountSnapshotParams{
			ID: id, SnapshotTakenAt: pgconv.Timestamp(snapshotTakenAt),
		},
	)
	if err != nil {
		return Count{}, apierror.Wrap(apierror.CodeInternal, "更新库存盘点快照时间失败", err)
	}
	after := countFromRow(updated)
	if err := writeAudit(
		ctx, tx, actor, after, "update", "refresh",
		audit.Diff(countSnapshot(before), countSnapshot(after), auditedFields),
	); err != nil {
		return Count{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Count{}, writeError("刷新库存盘点单失败", err)
	}
	return after, nil
}

func (s *Service) Approve(
	ctx context.Context,
	actor *authz.Actor,
	id uuid.UUID,
) (Count, error) {
	if err := require(actor, "approve"); err != nil {
		return Count{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Count{}, apierror.Wrap(apierror.CodeInternal, "审核库存盘点单失败", err)
	}
	defer tx.Rollback(ctx)
	q := dbgen.New(tx)
	row, err := q.LockStockCount(ctx, id)
	if err := lockCountError(err, "锁定库存盘点单失败"); err != nil {
		return Count{}, err
	}
	before := countFromRow(row)
	if err := requireCompany(actor, before.CompanyID); err != nil {
		return Count{}, err
	}
	if before.Status != StatusDraft {
		return Count{}, apierror.New(apierror.CodeConflict, "仅草稿库存盘点单可审核")
	}
	items, err := q.ListStockCountItems(ctx, id)
	if err != nil {
		return Count{}, apierror.Wrap(apierror.CodeInternal, "读取库存盘点单行失败", err)
	}
	if len(items) == 0 {
		return Count{}, apierror.New(apierror.CodeConflict, "审核前必须至少填写一行盘点明细")
	}
	lockKeys := make([]string, 0, len(items))
	seen := make(map[uuid.UUID]struct{}, len(items))
	for _, raw := range items {
		item := itemFromRow(raw)
		if item.CountedQuantity == nil || item.ConvertedCounted == nil {
			return Count{}, apierror.New(apierror.CodeConflict, "审核前每行都必须填写实盘数量")
		}
		if _, ok := seen[item.MaterialID]; !ok {
			seen[item.MaterialID] = struct{}{}
			lockKeys = append(lockKeys, fmt.Sprintf(
				"inv_stock:%s:%s", before.WarehouseID, item.MaterialID,
			))
		}
	}
	sort.Strings(lockKeys)
	for _, key := range lockKeys {
		if err := q.LockStockBalanceKey(ctx, key); err != nil {
			return Count{}, apierror.Wrap(apierror.CodeInternal, "锁定库存余额失败", err)
		}
	}
	stale, err := q.StockCountSnapshotIsStale(
		ctx,
		dbgen.StockCountSnapshotIsStaleParams{
			CompanyID: before.CompanyID, WarehouseID: before.WarehouseID,
			SnapshotTakenAt: pgconv.Timestamp(before.SnapshotTakenAt),
		},
	)
	if err != nil {
		return Count{}, apierror.Wrap(apierror.CodeInternal, "校验库存盘点快照失败", err)
	}
	if stale {
		return Count{}, apierror.New(apierror.CodeConflict, "库存已在快照后变化，请先刷新账面数量")
	}
	lines := make([]stock.Line, 0, len(items))
	for _, raw := range items {
		item := itemFromRow(raw)
		delta := item.ConvertedCounted.Sub(item.BookQuantity)
		if delta.IsZero() {
			continue
		}
		lines = append(lines, stock.Line{
			WarehouseID: before.WarehouseID, MaterialID: item.MaterialID,
			Quantity: delta, Remarks: before.Summary,
		})
	}
	if len(lines) > 0 {
		if err := stock.Post(ctx, tx, stock.Voucher{
			Type: "inv.stock_count", ID: before.ID, No: before.DocNo,
			CompanyID: before.CompanyID, PostingDate: before.PostingDate,
		}, lines); err != nil {
			return Count{}, err
		}
	}
	now := time.Now().UTC()
	var auditedByID *uuid.UUID
	if actor.UserID != uuid.Nil {
		auditedByID = &actor.UserID
	}
	updated, err := q.ApproveStockCount(ctx, dbgen.ApproveStockCountParams{
		ID: id, AuditedAt: pgconv.Timestamp(now), AuditedByID: auditedByID,
	})
	if err != nil {
		return Count{}, apierror.Wrap(apierror.CodeInternal, "更新库存盘点审核状态失败", err)
	}
	after := countFromRow(updated)
	if err := writeAudit(
		ctx, tx, actor, after, "update", "approve",
		audit.Diff(countSnapshot(before), countSnapshot(after), auditedFields),
	); err != nil {
		return Count{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Count{}, writeError("审核库存盘点单失败", err)
	}
	return after, nil
}

func (s *Service) Cancel(
	ctx context.Context,
	actor *authz.Actor,
	id uuid.UUID,
) (Count, error) {
	if err := require(actor, "cancel"); err != nil {
		return Count{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Count{}, apierror.Wrap(apierror.CodeInternal, "作废库存盘点单失败", err)
	}
	defer tx.Rollback(ctx)
	q := dbgen.New(tx)
	row, err := q.LockStockCount(ctx, id)
	if err := lockCountError(err, "锁定库存盘点单失败"); err != nil {
		return Count{}, err
	}
	before := countFromRow(row)
	if err := requireCompany(actor, before.CompanyID); err != nil {
		return Count{}, err
	}
	if before.Status != StatusAudited {
		return Count{}, apierror.New(apierror.CodeConflict, "仅已审核库存盘点单可作废")
	}
	if err := stock.Cancel(
		ctx, tx, stock.VoucherRef{Type: "inv.stock_count", ID: id}, time.Now().UTC(),
	); err != nil {
		return Count{}, err
	}
	updated, err := q.CancelStockCount(ctx, id)
	if err != nil {
		return Count{}, apierror.Wrap(apierror.CodeInternal, "更新库存盘点作废状态失败", err)
	}
	after := countFromRow(updated)
	if err := writeAudit(
		ctx, tx, actor, after, "update", "cancel",
		audit.Diff(countSnapshot(before), countSnapshot(after), auditedFields),
	); err != nil {
		return Count{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Count{}, writeError("作废库存盘点单失败", err)
	}
	return after, nil
}
