package standard

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/z1coyan/synie/server/internal/db/dbgen"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

type scanner interface {
	Scan(...any) error
}

func (s *Service) GetHead(
	ctx context.Context, actor *authz.Actor, side Side, id uuid.UUID,
) (Head, error) {
	spec, err := specFor(side)
	if err != nil {
		return Head{}, err
	}
	if err := require(actor, spec, "read"); err != nil {
		return Head{}, err
	}
	item, err := queryHeadByID(ctx, s.pool, spec, id, false)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && !actor.CanAccessCompany(item.CompanyID)) {
		return Head{}, apierror.New(apierror.CodeNotFound, spec.label+"不存在")
	}
	if err != nil {
		return Head{}, apierror.Wrap(apierror.CodeInternal, "读取"+spec.label+"失败", err)
	}
	return item, nil
}

func (s *Service) ListHeads(
	ctx context.Context, actor *authz.Actor, side Side, query ListQuery,
) (HeadListResult, error) {
	spec, err := specFor(side)
	if err != nil {
		return HeadListResult{}, err
	}
	if err := require(actor, spec, "read"); err != nil {
		return HeadListResult{}, err
	}
	if err := validatePage(&query); err != nil {
		return HeadListResult{}, err
	}
	built, err := filterbuild.Build(HeadResourceMeta(side), filterbuild.Query{
		Limit: query.Limit, Offset: query.Offset, Search: query.Search,
		Sort: query.Sort, Filter: query.Filter,
	})
	if err != nil {
		return HeadListResult{}, err
	}
	where, args := scopedWhere(actor, built.Where, append([]any(nil), built.Args...))
	orderBy := built.OrderBy
	if orderBy == "" {
		orderBy = ` ORDER BY "` + headDateColumn(spec) + `" DESC,"inserted_at" DESC,"id" DESC`
	} else {
		orderBy += `,"id" DESC`
	}
	source := headSource(spec)
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return HeadListResult{}, apierror.Wrap(apierror.CodeInternal, "查询"+spec.label+"失败", err)
	}
	defer tx.Rollback(ctx)
	var result HeadListResult
	if err := tx.QueryRow(ctx, `SELECT count(*)`+source+where, args...).Scan(&result.Count); err != nil {
		return HeadListResult{}, apierror.Wrap(apierror.CodeInternal, "统计"+spec.label+"失败", err)
	}
	listArgs := append([]any(nil), args...)
	limitAt := len(listArgs) + 1
	listArgs = append(listArgs, query.Limit, query.Offset)
	rows, err := tx.Query(ctx, headSelect(spec)+source+where+orderBy+
		fmt.Sprintf(" LIMIT $%d OFFSET $%d", limitAt, limitAt+1), listArgs...)
	if err != nil {
		return HeadListResult{}, apierror.Wrap(apierror.CodeInternal, "查询"+spec.label+"失败", err)
	}
	defer rows.Close()
	result.Results = make([]Head, 0, query.Limit)
	for rows.Next() {
		item, scanErr := scanHead(rows)
		if scanErr != nil {
			return HeadListResult{}, apierror.Wrap(apierror.CodeInternal, "读取"+spec.label+"结果失败", scanErr)
		}
		result.Results = append(result.Results, item)
	}
	if err := rows.Err(); err != nil {
		return HeadListResult{}, apierror.Wrap(apierror.CodeInternal, "遍历"+spec.label+"结果失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return HeadListResult{}, apierror.Wrap(apierror.CodeInternal, "完成"+spec.label+"查询失败", err)
	}
	return result, nil
}

func (s *Service) GetItem(
	ctx context.Context, actor *authz.Actor, side Side, id uuid.UUID,
) (Item, error) {
	spec, err := specFor(side)
	if err != nil {
		return Item{}, err
	}
	if err := require(actor, spec, "read"); err != nil {
		return Item{}, err
	}
	item, err := queryItemByID(ctx, s.pool, spec, id, false)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && !actor.CanAccessCompany(item.CompanyID)) {
		return Item{}, apierror.New(apierror.CodeNotFound, spec.itemLabel+"不存在")
	}
	if err != nil {
		return Item{}, apierror.Wrap(apierror.CodeInternal, "读取"+spec.itemLabel+"失败", err)
	}
	return item, nil
}

func (s *Service) ListItems(
	ctx context.Context, actor *authz.Actor, side Side, query ListQuery,
) (ItemListResult, error) {
	spec, err := specFor(side)
	if err != nil {
		return ItemListResult{}, err
	}
	if err := require(actor, spec, "read"); err != nil {
		return ItemListResult{}, err
	}
	if err := validatePage(&query); err != nil {
		return ItemListResult{}, err
	}
	built, err := filterbuild.Build(itemQueryResourceMeta(side), filterbuild.Query{
		Limit: query.Limit, Offset: query.Offset, Search: query.Search,
		Sort: query.Sort, Filter: query.Filter,
	})
	if err != nil {
		return ItemListResult{}, err
	}
	where, args := scopedWhere(actor, built.Where, append([]any(nil), built.Args...))
	orderBy := built.OrderBy
	if orderBy == "" {
		orderBy = ` ORDER BY "idx" ASC,"id" ASC`
	} else {
		orderBy += `,"id" ASC`
	}
	source := itemSource(spec)
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return ItemListResult{}, apierror.Wrap(apierror.CodeInternal, "查询"+spec.itemLabel+"失败", err)
	}
	defer tx.Rollback(ctx)
	var result ItemListResult
	if err := tx.QueryRow(ctx, `SELECT count(*)`+source+where, args...).Scan(&result.Count); err != nil {
		return ItemListResult{}, apierror.Wrap(apierror.CodeInternal, "统计"+spec.itemLabel+"失败", err)
	}
	listArgs := append([]any(nil), args...)
	limitAt := len(listArgs) + 1
	listArgs = append(listArgs, query.Limit, query.Offset)
	rows, err := tx.Query(ctx, itemSelect(spec)+source+where+orderBy+
		fmt.Sprintf(" LIMIT $%d OFFSET $%d", limitAt, limitAt+1), listArgs...)
	if err != nil {
		return ItemListResult{}, apierror.Wrap(apierror.CodeInternal, "查询"+spec.itemLabel+"失败", err)
	}
	defer rows.Close()
	result.Results = make([]Item, 0, query.Limit)
	for rows.Next() {
		item, scanErr := scanItem(rows)
		if scanErr != nil {
			return ItemListResult{}, apierror.Wrap(apierror.CodeInternal, "读取"+spec.itemLabel+"结果失败", scanErr)
		}
		result.Results = append(result.Results, item)
	}
	if err := rows.Err(); err != nil {
		return ItemListResult{}, apierror.Wrap(apierror.CodeInternal, "遍历"+spec.itemLabel+"结果失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return ItemListResult{}, apierror.Wrap(apierror.CodeInternal, "完成"+spec.itemLabel+"查询失败", err)
	}
	return result, nil
}

func headSource(spec sideSpec) string {
	noColumn, dateColumn := "delivery_no", "delivery_date"
	if spec.side == SidePurchase {
		noColumn, dateColumn = "receipt_no", "receipt_date"
	}
	return ` FROM (SELECT id,` + noColumn + `,` + dateColumn + `,
		posting_date,party_type,party_id,remarks,status,audited_at,inserted_at,updated_at,
		company_id,warehouse_id,debit_account_id,credit_account_id,created_by_id,audited_by_id
		FROM ` + spec.headTable + `) heads`
}

func headSelect(spec sideSpec) string {
	return `SELECT id,` + headNoColumn(spec) + `,` + headDateColumn(spec) + `,posting_date,party_type,party_id,remarks,status,
		audited_at,inserted_at,updated_at,company_id,warehouse_id,debit_account_id,
		credit_account_id,created_by_id,audited_by_id`
}

func queryHeadByID(
	ctx context.Context, db interface {
		QueryRow(context.Context, string, ...any) pgx.Row
	}, spec sideSpec, id uuid.UUID, lock bool,
) (Head, error) {
	sql := headSelect(spec) + headSource(spec) + ` WHERE id=$1`
	if lock {
		sql = `SELECT h.id,h.` + headNoColumn(spec) + `,h.` + headDateColumn(spec) +
			`,h.posting_date,h.party_type,h.party_id,h.remarks,h.status,h.audited_at,
			h.inserted_at,h.updated_at,h.company_id,h.warehouse_id,h.debit_account_id,
			h.credit_account_id,h.created_by_id,h.audited_by_id FROM ` + spec.headTable +
			` h WHERE h.id=$1 FOR UPDATE`
	}
	return scanHead(db.QueryRow(ctx, sql, id))
}

func scanHead(row scanner) (Head, error) {
	var (
		item                         Head
		documentDate, postingDate    pgtype.Date
		remarks                      pgtype.Text
		auditedAt, inserted, updated pgtype.Timestamp
		status                       string
	)
	err := row.Scan(
		&item.ID, &item.No, &documentDate, &postingDate, &item.PartyType, &item.PartyID,
		&remarks, &status, &auditedAt, &inserted, &updated, &item.CompanyID,
		&item.WarehouseID, &item.DebitAccountID, &item.CreditAccountID,
		&item.CreatedByID, &item.AuditedByID,
	)
	if err != nil {
		return Head{}, err
	}
	item.DocumentDate = documentDate.Time
	item.PostingDate = datePtr(postingDate)
	item.Remarks = textPtr(remarks)
	item.Status = statusFromDB(status)
	item.AuditedAt = timestampPtr(auditedAt)
	item.InsertedAt, item.UpdatedAt = inserted.Time, updated.Time
	return item, nil
}

func itemSource(spec sideSpec) string {
	parentID, parentNo, parentDate, parentStatus := "delivery_id", "delivery_no", "delivery_date", "delivery_status"
	orderType := `NULL::text AS order_type`
	if spec.side == SidePurchase {
		parentID, parentNo, parentDate, parentStatus = "receipt_id", "receipt_no", "receipt_date", "receipt_status"
	} else {
		orderType = `(SELECT o.order_type FROM sal_order_item oi
			JOIN sal_order o ON o.id=oi.order_id WHERE oi.id=i.order_item_id) AS order_type`
	}
	return ` FROM (SELECT i.id,i.idx,i.qty,i.base_qty,i.material_code,i.material_name,
		i.material_spec,i.customer_part_no,i.unit_name,i.order_no,i.order_qty,i.order_base_qty,
		i.order_unit_name,i.order_price,i.order_amount,i.order_base_price,i.order_base_amount,
		i.order_tax_rate,i.order_currency_code,i.reconciled_qty,i.remarks,i.inserted_at,
		i.updated_at,i.` + parentID + ` AS head_id,i.company_id,i.order_item_id,i.material_id,
		i.unit_id,i.warehouse_id,h.` + headNoColumn(spec) + ` AS ` + parentNo + `,
		h.` + headDateColumn(spec) + ` AS ` + parentDate + `,h.status AS ` + parentStatus + `,
		h.party_type,h.party_id,(i.base_qty-i.reconciled_qty) AS remaining_reconcilable_qty,` + orderType + `
		FROM ` + spec.itemTable + ` i JOIN ` + spec.headTable + ` h ON h.id=i.` + parentID + `) items`
}

func itemSelect(spec sideSpec) string {
	parentNo, parentDate, parentStatus := "delivery_no", "delivery_date", "delivery_status"
	if spec.side == SidePurchase {
		parentNo, parentDate, parentStatus = "receipt_no", "receipt_date", "receipt_status"
	}
	return `SELECT id,idx,qty,base_qty,material_code,material_name,material_spec,
		customer_part_no,unit_name,order_no,order_qty,order_base_qty,order_unit_name,
		order_price,order_amount,order_base_price,order_base_amount,order_tax_rate,
		order_currency_code,reconciled_qty,remarks,inserted_at,updated_at,head_id,company_id,
		order_item_id,material_id,unit_id,warehouse_id,` + parentNo + `,` + parentDate + `,
		` + parentStatus + `,party_type,party_id,remaining_reconcilable_qty`
}

func queryItemByID(
	ctx context.Context, db interface {
		QueryRow(context.Context, string, ...any) pgx.Row
	}, spec sideSpec, id uuid.UUID, lock bool,
) (Item, error) {
	if !lock {
		return scanItem(db.QueryRow(ctx, itemSelect(spec)+itemSource(spec)+` WHERE id=$1`, id))
	}
	parentID := "delivery_id"
	if spec.side == SidePurchase {
		parentID = "receipt_id"
	}
	sql := `SELECT i.id,i.idx,i.qty,i.base_qty,i.material_code,i.material_name,i.material_spec,
		i.customer_part_no,i.unit_name,i.order_no,i.order_qty,i.order_base_qty,i.order_unit_name,
		i.order_price,i.order_amount,i.order_base_price,i.order_base_amount,i.order_tax_rate,
		i.order_currency_code,i.reconciled_qty,i.remarks,i.inserted_at,i.updated_at,i.` + parentID + `,
		i.company_id,i.order_item_id,i.material_id,i.unit_id,i.warehouse_id,
		h.` + headNoColumn(spec) + `,h.` + headDateColumn(spec) + `,h.status,h.party_type,h.party_id,
		(i.base_qty-i.reconciled_qty) FROM ` + spec.itemTable + ` i
		JOIN ` + spec.headTable + ` h ON h.id=i.` + parentID + `
		WHERE i.id=$1 FOR UPDATE OF i`
	return scanItem(db.QueryRow(ctx, sql, id))
}

func scanItem(row scanner) (Item, error) {
	var (
		item                  Item
		materialSpec          pgtype.Text
		customerPartNo        pgtype.Text
		remarks               pgtype.Text
		insertedAt, updatedAt pgtype.Timestamp
		headDate              pgtype.Date
		headStatus            string
	)
	err := row.Scan(
		&item.ID, &item.Idx, &item.Qty, &item.BaseQty, &item.MaterialCode, &item.MaterialName,
		&materialSpec, &customerPartNo, &item.UnitName, &item.OrderNo, &item.OrderQty,
		&item.OrderBaseQty, &item.OrderUnitName, &item.OrderPrice, &item.OrderAmount,
		&item.OrderBasePrice, &item.OrderBaseAmount, &item.OrderTaxRate,
		&item.OrderCurrencyCode, &item.ReconciledQty, &remarks, &insertedAt, &updatedAt,
		&item.HeadID, &item.CompanyID, &item.OrderItemID, &item.MaterialID, &item.UnitID,
		&item.WarehouseID, &item.HeadNo, &headDate, &headStatus, &item.PartyType,
		&item.PartyID, &item.RemainingReconcilableQty,
	)
	if err != nil {
		return Item{}, err
	}
	item.MaterialSpec, item.CustomerPartNo, item.Remarks =
		textPtr(materialSpec), textPtr(customerPartNo), textPtr(remarks)
	item.InsertedAt, item.UpdatedAt = insertedAt.Time, updatedAt.Time
	item.HeadDate, item.HeadStatus = headDate.Time, statusFromDB(headStatus)
	return item, nil
}

func headNoColumn(spec sideSpec) string {
	if spec.side == SideSales {
		return "delivery_no"
	}
	return "receipt_no"
}

func headDateColumn(spec sideSpec) string {
	if spec.side == SideSales {
		return "delivery_date"
	}
	return "receipt_date"
}

func headFromSalesRow(row dbgen.SalDelivery) Head {
	return Head{
		ID: row.ID, No: row.DeliveryNo, DocumentDate: row.DeliveryDate.Time,
		PostingDate: datePtr(row.PostingDate), PartyType: row.PartyType, PartyID: row.PartyID,
		Remarks: textPtr(row.Remarks), Status: statusFromDB(row.Status),
		AuditedAt: timestampPtr(row.AuditedAt), InsertedAt: row.InsertedAt.Time,
		UpdatedAt: row.UpdatedAt.Time, CompanyID: row.CompanyID, WarehouseID: row.WarehouseID,
		DebitAccountID: row.DebitAccountID, CreditAccountID: row.CreditAccountID,
		CreatedByID: row.CreatedByID, AuditedByID: row.AuditedByID,
	}
}

func headFromPurchaseRow(row dbgen.PurReceipt) Head {
	return Head{
		ID: row.ID, No: row.ReceiptNo, DocumentDate: row.ReceiptDate.Time,
		PostingDate: datePtr(row.PostingDate), PartyType: row.PartyType, PartyID: row.PartyID,
		Remarks: textPtr(row.Remarks), Status: statusFromDB(row.Status),
		AuditedAt: timestampPtr(row.AuditedAt), InsertedAt: row.InsertedAt.Time,
		UpdatedAt: row.UpdatedAt.Time, CompanyID: row.CompanyID, WarehouseID: row.WarehouseID,
		DebitAccountID: row.DebitAccountID, CreditAccountID: row.CreditAccountID,
		CreatedByID: row.CreatedByID, AuditedByID: row.AuditedByID,
	}
}
