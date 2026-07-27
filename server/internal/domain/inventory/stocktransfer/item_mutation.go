package stocktransfer

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/z1coyan/synie/server/internal/db/dbgen"
	"github.com/z1coyan/synie/server/internal/db/pgconv"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/audit"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

func (s *Service) UpdateItem(
	ctx context.Context,
	actor *authz.Actor,
	id uuid.UUID,
	input UpdateItemInput,
) (Item, error) {
	if err := require(actor, "update"); err != nil {
		return Item{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Item{}, apierror.Wrap(apierror.CodeInternal, "更新手工调拨单行失败", err)
	}
	defer tx.Rollback(ctx)
	q := dbgen.New(tx)
	current, err := q.GetStockTransferItem(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Item{}, apierror.New(apierror.CodeNotFound, "手工调拨单行不存在")
	}
	if err != nil {
		return Item{}, apierror.Wrap(apierror.CodeInternal, "读取手工调拨单行失败", err)
	}
	if _, err := lockDraftTransfer(ctx, q, actor, current.StockTransferID); err != nil {
		return Item{}, err
	}
	locked, err := q.LockStockTransferItem(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Item{}, apierror.New(apierror.CodeNotFound, "手工调拨单行不存在")
	}
	if err != nil {
		return Item{}, apierror.Wrap(apierror.CodeInternal, "锁定手工调拨单行失败", err)
	}
	before := itemFromRow(locked)
	after := before
	if input.Idx != nil {
		after.Idx = *input.Idx
	}
	if input.Qty != nil {
		after.Qty = *input.Qty
	}
	if input.MaterialID != nil {
		after.MaterialID = *input.MaterialID
	}
	if input.UnitID != nil {
		after.UnitID = *input.UnitID
	}
	if input.Remark.Set {
		after.Remark = input.Remark.Value
	}
	if err := validateItemInput(after.Qty, after.MaterialID, after.UnitID, after.Remark); err != nil {
		return Item{}, err
	}
	projection, err := buildProjection(ctx, q, after.MaterialID, after.UnitID, after.Qty)
	if err != nil {
		return Item{}, err
	}
	after.BaseQty = projection.baseQty
	after.MaterialCode = projection.materialCode
	after.MaterialName = projection.materialName
	after.MaterialSpec = projection.materialSpec
	after.UnitName = projection.unitName
	changes := audit.Diff(itemSnapshot(before), itemSnapshot(after), itemAuditedFields)
	if len(changes) == 0 {
		if err := tx.Commit(ctx); err != nil {
			return Item{}, apierror.Wrap(apierror.CodeInternal, "更新手工调拨单行失败", err)
		}
		return before, nil
	}
	row, err := q.UpdateStockTransferItem(ctx, dbgen.UpdateStockTransferItemParams{
		ID: id, Idx: after.Idx, Qty: after.Qty, BaseQty: after.BaseQty,
		MaterialCode: after.MaterialCode, MaterialName: after.MaterialName,
		MaterialSpec: pgconv.Text(after.MaterialSpec), UnitName: after.UnitName,
		Remark: pgconv.Text(after.Remark), MaterialID: after.MaterialID, UnitID: after.UnitID,
	})
	if err != nil {
		return Item{}, apierror.Wrap(apierror.CodeInternal, "更新手工调拨单行失败", err)
	}
	item := itemFromRow(row)
	if err := writeItemAudit(ctx, tx, actor, item, "update", "update", changes); err != nil {
		return Item{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Item{}, apierror.Wrap(apierror.CodeInternal, "更新手工调拨单行失败", err)
	}
	return item, nil
}

func (s *Service) DeleteItem(ctx context.Context, actor *authz.Actor, id uuid.UUID) error {
	if err := require(actor, "delete"); err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除手工调拨单行失败", err)
	}
	defer tx.Rollback(ctx)
	q := dbgen.New(tx)
	current, err := q.GetStockTransferItem(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return apierror.New(apierror.CodeNotFound, "手工调拨单行不存在")
	}
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "读取手工调拨单行失败", err)
	}
	if _, err := lockDraftTransfer(ctx, q, actor, current.StockTransferID); err != nil {
		return err
	}
	locked, err := q.LockStockTransferItem(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return apierror.New(apierror.CodeNotFound, "手工调拨单行不存在")
	}
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "锁定手工调拨单行失败", err)
	}
	item := itemFromRow(locked)
	if _, err := q.DeleteStockTransferItem(ctx, id); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除手工调拨单行失败", err)
	}
	if err := writeItemAudit(ctx, tx, actor, item, "destroy", "destroy",
		audit.Destroyed(itemSnapshot(item), itemAuditedFields)); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除手工调拨单行失败", err)
	}
	return nil
}
