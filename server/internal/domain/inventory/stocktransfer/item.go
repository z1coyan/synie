package stocktransfer

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/z1coyan/synie/server/internal/db/dbgen"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/audit"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

func (s *Service) GetItem(ctx context.Context, actor *authz.Actor, id uuid.UUID) (Item, error) {
	if err := require(actor, "read"); err != nil {
		return Item{}, err
	}
	row, err := dbgen.New(s.pool).GetStockTransferItem(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Item{}, apierror.New(apierror.CodeNotFound, "手工调拨单行不存在")
	}
	if err != nil {
		return Item{}, apierror.Wrap(apierror.CodeInternal, "读取手工调拨单行失败", err)
	}
	if !actor.CanAccessCompany(row.CompanyID) {
		return Item{}, apierror.New(apierror.CodeNotFound, "手工调拨单行不存在")
	}
	return itemFromRow(row), nil
}

func (s *Service) ListItems(ctx context.Context, actor *authz.Actor, transferID uuid.UUID) ([]Item, error) {
	if err := require(actor, "read"); err != nil {
		return nil, err
	}
	q := dbgen.New(s.pool)
	doc, err := q.GetStockTransfer(ctx, transferID)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && !actor.CanAccessCompany(doc.CompanyID)) {
		return nil, apierror.New(apierror.CodeNotFound, "手工调拨单不存在")
	}
	if err != nil {
		return nil, apierror.Wrap(apierror.CodeInternal, "读取手工调拨单失败", err)
	}
	rows, err := q.ListStockTransferItems(ctx, transferID)
	if err != nil {
		return nil, apierror.Wrap(apierror.CodeInternal, "读取手工调拨单行失败", err)
	}
	result := make([]Item, 0, len(rows))
	for _, row := range rows {
		result = append(result, itemFromRow(row))
	}
	return result, nil
}

func (s *Service) CreateItem(ctx context.Context, actor *authz.Actor, input CreateItemInput) (Item, error) {
	if err := require(actor, "create"); err != nil {
		return Item{}, err
	}
	if err := validateItemInput(input.Qty, input.MaterialID, input.UnitID, input.Remark); err != nil {
		return Item{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Item{}, apierror.Wrap(apierror.CodeInternal, "创建手工调拨单行失败", err)
	}
	defer tx.Rollback(ctx)
	q := dbgen.New(tx)
	doc, err := lockDraftTransfer(ctx, q, actor, input.StockTransferID)
	if err != nil {
		return Item{}, err
	}
	projection, err := buildProjection(ctx, q, input.MaterialID, input.UnitID, input.Qty)
	if err != nil {
		return Item{}, err
	}
	row, err := q.CreateStockTransferItem(ctx, dbgen.CreateStockTransferItemParams{
		Idx: input.Idx, Qty: input.Qty, BaseQty: projection.baseQty,
		MaterialCode: projection.materialCode, MaterialName: projection.materialName,
		MaterialSpec: text(projection.materialSpec), UnitName: projection.unitName,
		Remark: text(input.Remark), StockTransferID: input.StockTransferID,
		CompanyID: doc.CompanyID, MaterialID: input.MaterialID, UnitID: input.UnitID,
	})
	if err != nil {
		return Item{}, apierror.Wrap(apierror.CodeInternal, "创建手工调拨单行失败", err)
	}
	item := itemFromRow(row)
	if err := writeItemAudit(ctx, tx, actor, item, "create", "create",
		audit.Created(itemSnapshot(item), itemAuditedFields)); err != nil {
		return Item{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Item{}, apierror.Wrap(apierror.CodeInternal, "创建手工调拨单行失败", err)
	}
	return item, nil
}
