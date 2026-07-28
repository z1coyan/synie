package quotation

import (
	"context"
	"errors"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/audit"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

var tierAuditFields = []string{"min_qty", "price", "item_id", "company_id"}

func (s *Service) CreateTier(
	ctx context.Context,
	actor *authz.Actor,
	side Side,
	input CreateTierInput,
) (Tier, error) {
	spec, err := specFor(side)
	if err != nil {
		return Tier{}, err
	}
	if err := require(actor, spec, "create"); err != nil {
		return Tier{}, err
	}
	if err := validateTierShape(input.MinQty, input.Price); err != nil {
		return Tier{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Tier{}, apierror.Wrap(apierror.CodeInternal, "创建报价价格档失败", err)
	}
	defer tx.Rollback(ctx)
	quotationID, companyID, mode, err := tierParent(ctx, tx, spec, input.ItemID)
	if err != nil {
		return Tier{}, err
	}
	if _, err := lockDraftQuotation(ctx, tx, spec, actor, quotationID, "tier"); err != nil {
		return Tier{}, err
	}
	if mode != "qty_tiered" {
		return Tier{}, apierror.Validation("报价价格档参数不合法",
			map[string][]string{"itemId": {"仅数量梯度条目可维护价格档"}})
	}
	_, _, mode, err = tierParent(ctx, tx, spec, input.ItemID)
	if err != nil {
		return Tier{}, err
	}
	if mode != "qty_tiered" {
		return Tier{}, apierror.Validation("报价价格档参数不合法",
			map[string][]string{"itemId": {"仅数量梯度条目可维护价格档"}})
	}
	var id uuid.UUID
	err = tx.QueryRow(ctx, `INSERT INTO `+spec.tierTable+
		` (min_qty,price,item_id,company_id) VALUES ($1,$2,$3,$4) RETURNING id`,
		input.MinQty, input.Price, input.ItemID, companyID).Scan(&id)
	if err != nil {
		return Tier{}, writeError("创建报价价格档失败", err)
	}
	row, err := queryTierByID(ctx, tx, spec, id)
	if err != nil {
		return Tier{}, apierror.Wrap(apierror.CodeInternal, "读取新建报价价格档失败", err)
	}
	item := tierFromRow(row)
	if err := writeAudit(ctx, tx, actor, spec.tierAuditResource, id, item.MinQty.String(),
		"create", "create", item.CompanyID,
		audit.Created(tierSnapshot(item), tierAuditFields)); err != nil {
		return Tier{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Tier{}, writeError("创建报价价格档失败", err)
	}
	return item, nil
}

func (s *Service) UpdateTier(
	ctx context.Context,
	actor *authz.Actor,
	side Side,
	id uuid.UUID,
	input UpdateTierInput,
) (Tier, error) {
	spec, err := specFor(side)
	if err != nil {
		return Tier{}, err
	}
	if err := require(actor, spec, "update"); err != nil {
		return Tier{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Tier{}, apierror.Wrap(apierror.CodeInternal, "更新报价价格档失败", err)
	}
	defer tx.Rollback(ctx)
	beforeRow, err := queryTierByID(ctx, tx, spec, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Tier{}, tierNotFound()
	}
	if err != nil {
		return Tier{}, apierror.Wrap(apierror.CodeInternal, "读取报价价格档失败", err)
	}
	quotationID, _, mode, err := tierParent(ctx, tx, spec, beforeRow.ItemID)
	if err != nil {
		return Tier{}, err
	}
	if _, err := lockDraftQuotation(ctx, tx, spec, actor, quotationID, "tier"); err != nil {
		return Tier{}, err
	}
	_, _, mode, err = tierParent(ctx, tx, spec, beforeRow.ItemID)
	if err != nil {
		return Tier{}, err
	}
	if mode != "qty_tiered" {
		return Tier{}, apierror.Validation("报价价格档参数不合法",
			map[string][]string{"itemId": {"仅数量梯度条目可维护价格档"}})
	}
	before := tierFromRow(beforeRow)
	after := before
	if input.MinQty != nil {
		after.MinQty = *input.MinQty
	}
	if input.Price != nil {
		after.Price = *input.Price
	}
	if err := validateTierShape(after.MinQty, after.Price); err != nil {
		return Tier{}, err
	}
	changes := audit.Diff(tierSnapshot(before), tierSnapshot(after), tierAuditFields)
	if len(changes) == 0 {
		if err := tx.Commit(ctx); err != nil {
			return Tier{}, writeError("更新报价价格档失败", err)
		}
		return before, nil
	}
	if _, err := tx.Exec(ctx, `UPDATE `+spec.tierTable+` SET min_qty=$2,price=$3,
		updated_at=(now() AT TIME ZONE 'utc') WHERE id=$1`, id, after.MinQty, after.Price); err != nil {
		return Tier{}, writeError("更新报价价格档失败", err)
	}
	row, err := queryTierByID(ctx, tx, spec, id)
	if err != nil {
		return Tier{}, apierror.Wrap(apierror.CodeInternal, "读取更新后报价价格档失败", err)
	}
	item := tierFromRow(row)
	if err := writeAudit(ctx, tx, actor, spec.tierAuditResource, id, item.MinQty.String(),
		"update", "update", item.CompanyID, changes); err != nil {
		return Tier{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Tier{}, writeError("更新报价价格档失败", err)
	}
	return item, nil
}

func (s *Service) DeleteTier(ctx context.Context, actor *authz.Actor, side Side, id uuid.UUID) error {
	spec, err := specFor(side)
	if err != nil {
		return err
	}
	if err := require(actor, spec, "delete"); err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除报价价格档失败", err)
	}
	defer tx.Rollback(ctx)
	row, err := queryTierByID(ctx, tx, spec, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return tierNotFound()
	}
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "读取报价价格档失败", err)
	}
	quotationID, _, mode, err := tierParent(ctx, tx, spec, row.ItemID)
	if err != nil {
		return err
	}
	if _, err := lockDraftQuotation(ctx, tx, spec, actor, quotationID, "tier"); err != nil {
		return err
	}
	_, _, mode, err = tierParent(ctx, tx, spec, row.ItemID)
	if err != nil {
		return err
	}
	if mode != "qty_tiered" {
		return apierror.Validation("报价价格档参数不合法",
			map[string][]string{"itemId": {"仅数量梯度条目可维护价格档"}})
	}
	item := tierFromRow(row)
	if err := writeAudit(ctx, tx, actor, spec.tierAuditResource, id, item.MinQty.String(),
		"destroy", "destroy", item.CompanyID,
		audit.Destroyed(tierSnapshot(item), tierAuditFields)); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM `+spec.tierTable+` WHERE id=$1`, id); err != nil {
		return writeError("删除报价价格档失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return writeError("删除报价价格档失败", err)
	}
	return nil
}

func tierParent(
	ctx context.Context,
	tx pgx.Tx,
	spec sideSpec,
	itemID uuid.UUID,
) (uuid.UUID, uuid.UUID, string, error) {
	var quotationID, companyID uuid.UUID
	var mode string
	err := tx.QueryRow(ctx, `SELECT quotation_id,company_id,pricing_mode FROM `+
		spec.itemTable+` WHERE id=$1`, itemID).Scan(&quotationID, &companyID, &mode)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, uuid.Nil, "", itemNotFound()
	}
	if err != nil {
		return uuid.Nil, uuid.Nil, "", apierror.Wrap(apierror.CodeInternal, "读取报价条目失败", err)
	}
	return quotationID, companyID, strings.ToLower(mode), nil
}

func validateTierShape(minQty, price decimal.Decimal) error {
	fields := map[string][]string{}
	if !minQty.IsPositive() {
		fields["minQty"] = []string{"起订量必须大于零"}
	}
	if price.IsNegative() {
		fields["price"] = []string{"含税档价不能为负"}
	}
	if len(fields) > 0 {
		return apierror.Validation("报价价格档参数不合法", fields)
	}
	return nil
}

func queryTierByID(ctx context.Context, tx pgx.Tx, spec sideSpec, id uuid.UUID) (tierRow, error) {
	return scanTierRow(tx.QueryRow(ctx, `SELECT id,min_qty,price,inserted_at,
		updated_at,item_id,company_id,company_name`+tierSource(spec)+` WHERE id=$1`, id))
}

func purgeTiers(
	ctx context.Context,
	tx pgx.Tx,
	actor *authz.Actor,
	spec sideSpec,
	itemID uuid.UUID,
) error {
	rows, err := tx.Query(ctx, `SELECT id,min_qty,price,inserted_at,updated_at,item_id,
		company_id,company_name`+tierSource(spec)+` WHERE item_id=$1 ORDER BY min_qty,id`, itemID)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "读取待清空报价价格档失败", err)
	}
	var items []Tier
	for rows.Next() {
		row, scanErr := scanTierRow(rows)
		if scanErr != nil {
			rows.Close()
			return apierror.Wrap(apierror.CodeInternal, "读取待清空报价价格档失败", scanErr)
		}
		items = append(items, tierFromRow(row))
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return apierror.Wrap(apierror.CodeInternal, "遍历待清空报价价格档失败", err)
	}
	rows.Close()
	if _, err := tx.Exec(ctx, `DELETE FROM `+spec.tierTable+` WHERE item_id=$1`, itemID); err != nil {
		return writeError("清空报价价格档失败", err)
	}
	for _, item := range items {
		if err := writeAudit(ctx, tx, actor, spec.tierAuditResource, item.ID, item.MinQty.String(),
			"destroy", "purge", item.CompanyID,
			audit.Destroyed(tierSnapshot(item), tierAuditFields)); err != nil {
			return err
		}
	}
	return nil
}

func tierSnapshot(item Tier) map[string]any {
	return map[string]any{
		"min_qty": item.MinQty, "price": item.Price,
		"item_id": item.ItemID, "company_id": item.CompanyID,
	}
}
