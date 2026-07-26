package outsourced

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/platform/meta"
)

type scanner interface{ Scan(...any) error }

type queryer interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func (s *Service) GetIssue(ctx context.Context, actor *authz.Actor, id uuid.UUID) (Issue, error) {
	if err := require(actor, issuePermissionPrefix, "read"); err != nil {
		return Issue{}, err
	}
	item, err := queryIssue(ctx, s.pool, id, false)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && !actor.CanAccessCompany(item.CompanyID)) {
		return Issue{}, apierror.New(apierror.CodeNotFound, "委外发料单不存在")
	}
	if err != nil {
		return Issue{}, apierror.Wrap(apierror.CodeInternal, "读取委外发料单失败", err)
	}
	return item, nil
}

func (s *Service) GetReceipt(ctx context.Context, actor *authz.Actor, id uuid.UUID) (Receipt, error) {
	if err := require(actor, receiptPermissionPrefix, "read"); err != nil {
		return Receipt{}, err
	}
	item, err := queryReceipt(ctx, s.pool, id, false)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && !actor.CanAccessCompany(item.CompanyID)) {
		return Receipt{}, apierror.New(apierror.CodeNotFound, "委外入库单不存在")
	}
	if err != nil {
		return Receipt{}, apierror.Wrap(apierror.CodeInternal, "读取委外入库单失败", err)
	}
	return item, nil
}

func (s *Service) GetIssueItem(ctx context.Context, actor *authz.Actor, id uuid.UUID) (IssueItem, error) {
	if err := require(actor, issuePermissionPrefix, "read"); err != nil {
		return IssueItem{}, err
	}
	item, err := queryIssueItem(ctx, s.pool, id, false)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && !actor.CanAccessCompany(item.CompanyID)) {
		return IssueItem{}, apierror.New(apierror.CodeNotFound, "委外发料行不存在")
	}
	if err != nil {
		return IssueItem{}, apierror.Wrap(apierror.CodeInternal, "读取委外发料行失败", err)
	}
	return item, nil
}

func (s *Service) GetReceiptItem(ctx context.Context, actor *authz.Actor, id uuid.UUID) (ReceiptItem, error) {
	if err := require(actor, receiptPermissionPrefix, "read"); err != nil {
		return ReceiptItem{}, err
	}
	item, err := queryReceiptItem(ctx, s.pool, id, false)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && !actor.CanAccessCompany(item.CompanyID)) {
		return ReceiptItem{}, apierror.New(apierror.CodeNotFound, "委外入库成品行不存在")
	}
	if err != nil {
		return ReceiptItem{}, apierror.Wrap(apierror.CodeInternal, "读取委外入库成品行失败", err)
	}
	return item, nil
}

func (s *Service) GetReceiptMaterial(ctx context.Context, actor *authz.Actor, id uuid.UUID) (ReceiptMaterial, error) {
	if err := require(actor, receiptPermissionPrefix, "read"); err != nil {
		return ReceiptMaterial{}, err
	}
	item, err := queryReceiptMaterial(ctx, s.pool, id, false)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && !actor.CanAccessCompany(item.CompanyID)) {
		return ReceiptMaterial{}, apierror.New(apierror.CodeNotFound, "委外入库材料行不存在")
	}
	if err != nil {
		return ReceiptMaterial{}, apierror.Wrap(apierror.CodeInternal, "读取委外入库材料行失败", err)
	}
	return item, nil
}

func (s *Service) GetReceiptByproduct(ctx context.Context, actor *authz.Actor, id uuid.UUID) (ReceiptByproduct, error) {
	if err := require(actor, receiptPermissionPrefix, "read"); err != nil {
		return ReceiptByproduct{}, err
	}
	item, err := queryReceiptByproduct(ctx, s.pool, id, false)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && !actor.CanAccessCompany(item.CompanyID)) {
		return ReceiptByproduct{}, apierror.New(apierror.CodeNotFound, "委外入库副产物行不存在")
	}
	if err != nil {
		return ReceiptByproduct{}, apierror.Wrap(apierror.CodeInternal, "读取委外入库副产物行失败", err)
	}
	return item, nil
}

func (s *Service) GetIssueDetail(ctx context.Context, actor *authz.Actor, id uuid.UUID) (IssueDetail, error) {
	if err := require(actor, issuePermissionPrefix, "read"); err != nil {
		return IssueDetail{}, err
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{
		IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return IssueDetail{}, apierror.Wrap(apierror.CodeInternal, "读取委外发料详情失败", err)
	}
	defer tx.Rollback(ctx)
	head, err := queryIssue(ctx, tx, id, false)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && !actor.CanAccessCompany(head.CompanyID)) {
		return IssueDetail{}, apierror.New(apierror.CodeNotFound, "委外发料单不存在")
	}
	if err != nil {
		return IssueDetail{}, apierror.Wrap(apierror.CodeInternal, "读取委外发料详情失败", err)
	}
	rows, err := tx.Query(ctx, `SELECT id FROM pur_outsourced_issue_item
		WHERE issue_id=$1 ORDER BY idx,id`, id)
	if err != nil {
		return IssueDetail{}, apierror.Wrap(apierror.CodeInternal, "读取委外发料详情行失败", err)
	}
	var ids []uuid.UUID
	for rows.Next() {
		var itemID uuid.UUID
		if err := rows.Scan(&itemID); err != nil {
			rows.Close()
			return IssueDetail{}, apierror.Wrap(apierror.CodeInternal, "读取委外发料详情行失败", err)
		}
		ids = append(ids, itemID)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return IssueDetail{}, apierror.Wrap(apierror.CodeInternal, "遍历委外发料详情行失败", err)
	}
	rows.Close()
	result := IssueDetail{Issue: head, Items: make([]IssueItem, 0, len(ids))}
	for _, itemID := range ids {
		item, err := queryIssueItem(ctx, tx, itemID, false)
		if err != nil {
			return IssueDetail{}, apierror.Wrap(apierror.CodeInternal, "读取委外发料详情行失败", err)
		}
		result.Items = append(result.Items, item)
	}
	if err := tx.Commit(ctx); err != nil {
		return IssueDetail{}, apierror.Wrap(apierror.CodeInternal, "完成委外发料详情查询失败", err)
	}
	return result, nil
}

func (s *Service) GetReceiptDetail(ctx context.Context, actor *authz.Actor, id uuid.UUID) (ReceiptDetail, error) {
	if err := require(actor, receiptPermissionPrefix, "read"); err != nil {
		return ReceiptDetail{}, err
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{
		IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return ReceiptDetail{}, apierror.Wrap(apierror.CodeInternal, "读取委外入库详情失败", err)
	}
	defer tx.Rollback(ctx)
	head, err := queryReceipt(ctx, tx, id, false)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && !actor.CanAccessCompany(head.CompanyID)) {
		return ReceiptDetail{}, apierror.New(apierror.CodeNotFound, "委外入库单不存在")
	}
	if err != nil {
		return ReceiptDetail{}, apierror.Wrap(apierror.CodeInternal, "读取委外入库详情失败", err)
	}
	rows, err := tx.Query(ctx, `SELECT id FROM pur_outsourced_receipt_item
		WHERE receipt_id=$1 ORDER BY idx,id`, id)
	if err != nil {
		return ReceiptDetail{}, apierror.Wrap(apierror.CodeInternal, "读取委外入库详情行失败", err)
	}
	var ids []uuid.UUID
	for rows.Next() {
		var itemID uuid.UUID
		if err := rows.Scan(&itemID); err != nil {
			rows.Close()
			return ReceiptDetail{}, apierror.Wrap(apierror.CodeInternal, "读取委外入库详情行失败", err)
		}
		ids = append(ids, itemID)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return ReceiptDetail{}, apierror.Wrap(apierror.CodeInternal, "遍历委外入库详情行失败", err)
	}
	rows.Close()
	result := ReceiptDetail{Receipt: head, Items: make([]ReceiptItemDetail, 0, len(ids))}
	for _, itemID := range ids {
		item, err := queryReceiptItem(ctx, tx, itemID, false)
		if err != nil {
			return ReceiptDetail{}, apierror.Wrap(apierror.CodeInternal, "读取委外入库成品详情失败", err)
		}
		detail := ReceiptItemDetail{
			Item: item, Materials: []ReceiptMaterial{}, Byproducts: []ReceiptByproduct{},
		}
		childRows, err := tx.Query(ctx, `SELECT id,'material' FROM pur_outsourced_receipt_item_material
			WHERE receipt_item_id=$1 UNION ALL
			SELECT id,'byproduct' FROM pur_outsourced_receipt_item_byproduct
			WHERE receipt_item_id=$1 ORDER BY 1`, itemID)
		if err != nil {
			return ReceiptDetail{}, apierror.Wrap(apierror.CodeInternal, "读取委外入库子行详情失败", err)
		}
		type childRef struct {
			id   uuid.UUID
			kind string
		}
		var refs []childRef
		for childRows.Next() {
			var ref childRef
			if err := childRows.Scan(&ref.id, &ref.kind); err != nil {
				childRows.Close()
				return ReceiptDetail{}, apierror.Wrap(apierror.CodeInternal, "读取委外入库子行详情失败", err)
			}
			refs = append(refs, ref)
		}
		if err := childRows.Err(); err != nil {
			childRows.Close()
			return ReceiptDetail{}, apierror.Wrap(apierror.CodeInternal, "遍历委外入库子行详情失败", err)
		}
		childRows.Close()
		for _, ref := range refs {
			if ref.kind == "material" {
				child, err := queryReceiptMaterial(ctx, tx, ref.id, false)
				if err != nil {
					return ReceiptDetail{}, err
				}
				detail.Materials = append(detail.Materials, child)
			} else {
				child, err := queryReceiptByproduct(ctx, tx, ref.id, false)
				if err != nil {
					return ReceiptDetail{}, err
				}
				detail.Byproducts = append(detail.Byproducts, child)
			}
		}
		result.Items = append(result.Items, detail)
	}
	if err := tx.Commit(ctx); err != nil {
		return ReceiptDetail{}, apierror.Wrap(apierror.CodeInternal, "完成委外入库详情查询失败", err)
	}
	return result, nil
}

func (s *Service) ListIssues(ctx context.Context, actor *authz.Actor, query ListQuery) (ListResult[Issue], error) {
	if err := require(actor, issuePermissionPrefix, "read"); err != nil {
		return ListResult[Issue]{}, err
	}
	return listRows(ctx, s.pool, actor, query, IssueResourceMeta(), issueSource(), `"inserted_at" DESC,"id" DESC`, scanIssue)
}

func (s *Service) ListReceipts(ctx context.Context, actor *authz.Actor, query ListQuery) (ListResult[Receipt], error) {
	if err := require(actor, receiptPermissionPrefix, "read"); err != nil {
		return ListResult[Receipt]{}, err
	}
	return listRows(ctx, s.pool, actor, query, ReceiptResourceMeta(), receiptSource(), `"inserted_at" DESC,"id" DESC`, scanReceipt)
}

func (s *Service) ListIssueItems(ctx context.Context, actor *authz.Actor, query ListQuery) (ListResult[IssueItem], error) {
	if err := require(actor, issuePermissionPrefix, "read"); err != nil {
		return ListResult[IssueItem]{}, err
	}
	return listRows(ctx, s.pool, actor, query, IssueItemResourceMeta(), issueItemSource(), `"idx" ASC,"id" ASC`, scanIssueItem)
}

func (s *Service) ListReceiptItems(ctx context.Context, actor *authz.Actor, query ListQuery) (ListResult[ReceiptItem], error) {
	if err := require(actor, receiptPermissionPrefix, "read"); err != nil {
		return ListResult[ReceiptItem]{}, err
	}
	return listRows(ctx, s.pool, actor, query, ReceiptItemResourceMeta(), receiptItemSource(), `"idx" ASC,"id" ASC`, scanReceiptItem)
}

func (s *Service) ListReceiptMaterials(ctx context.Context, actor *authz.Actor, query ListQuery) (ListResult[ReceiptMaterial], error) {
	if err := require(actor, receiptPermissionPrefix, "read"); err != nil {
		return ListResult[ReceiptMaterial]{}, err
	}
	return listRows(ctx, s.pool, actor, query, ReceiptMaterialResourceMeta(), receiptMaterialSource(), `"idx" ASC,"id" ASC`, scanReceiptMaterial)
}

func (s *Service) ListReceiptByproducts(ctx context.Context, actor *authz.Actor, query ListQuery) (ListResult[ReceiptByproduct], error) {
	if err := require(actor, receiptPermissionPrefix, "read"); err != nil {
		return ListResult[ReceiptByproduct]{}, err
	}
	return listRows(ctx, s.pool, actor, query, ReceiptByproductResourceMeta(), receiptByproductSource(), `"idx" ASC,"id" ASC`, scanReceiptByproduct)
}

func listRows[T any](
	ctx context.Context,
	pool *pgxpool.Pool,
	actor *authz.Actor,
	query ListQuery,
	resource meta.ResourceMeta,
	source, defaultOrder string,
	scan func(scanner) (T, error),
) (ListResult[T], error) {
	if err := validatePage(&query); err != nil {
		return ListResult[T]{}, err
	}
	built, err := filterbuild.Build(resource, filterbuild.Query{
		Limit: query.Limit, Offset: query.Offset, Search: query.Search,
		Sort: query.Sort, Filter: query.Filter,
	})
	if err != nil {
		return ListResult[T]{}, err
	}
	where, args := scopedWhere(actor, built.Where, built.Args)
	orderBy := built.OrderBy
	if orderBy == "" {
		orderBy = " ORDER BY " + defaultOrder
	} else {
		orderBy += `,"id" ASC`
	}
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return ListResult[T]{}, apierror.Wrap(apierror.CodeInternal, "查询委外履约资源失败", err)
	}
	defer tx.Rollback(ctx)
	var result ListResult[T]
	if err := tx.QueryRow(ctx, "SELECT count(*) "+source+where, args...).Scan(&result.Count); err != nil {
		return ListResult[T]{}, apierror.Wrap(apierror.CodeInternal, "统计委外履约资源失败", err)
	}
	listArgs, at := append([]any(nil), args...), len(args)+1
	listArgs = append(listArgs, query.Limit, query.Offset)
	rows, err := tx.Query(ctx, "SELECT * "+source+where+orderBy+
		fmt.Sprintf(" LIMIT $%d OFFSET $%d", at, at+1), listArgs...)
	if err != nil {
		return ListResult[T]{}, apierror.Wrap(apierror.CodeInternal, "查询委外履约资源失败", err)
	}
	defer rows.Close()
	result.Results = make([]T, 0, query.Limit)
	for rows.Next() {
		item, err := scan(rows)
		if err != nil {
			return ListResult[T]{}, apierror.Wrap(apierror.CodeInternal, "读取委外履约结果失败", err)
		}
		result.Results = append(result.Results, item)
	}
	if err := rows.Err(); err != nil {
		return ListResult[T]{}, apierror.Wrap(apierror.CodeInternal, "遍历委外履约结果失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return ListResult[T]{}, apierror.Wrap(apierror.CodeInternal, "完成委外履约查询失败", err)
	}
	return result, nil
}

func issueSource() string {
	return `FROM (SELECT id,issue_no,issue_date,party_type,party_id,remarks,status,
		audited_at,inserted_at,updated_at,company_id,from_warehouse_id,
		outsourced_warehouse_id,created_by_id,audited_by_id FROM pur_outsourced_issue) AS r`
}

func receiptSource() string {
	return `FROM (SELECT id,receipt_no,receipt_date,posting_date,party_type,party_id,
		remarks,status,audited_at,inserted_at,updated_at,company_id,warehouse_id,
		outsourced_warehouse_id,debit_account_id,credit_account_id,created_by_id,
		audited_by_id FROM pur_outsourced_receipt) AS r`
}

func issueItemSource() string {
	return `FROM (SELECT i.id,i.idx,i.qty,i.base_qty,i.material_code,i.material_name,
		i.material_spec,i.unit_name,i.order_no,i.remarks,i.inserted_at,i.updated_at,
		i.issue_id,i.company_id,i.order_item_material_id,i.material_id,i.unit_id,
		i.from_warehouse_id,i.outsourced_warehouse_id,h.issue_no,h.issue_date,
		h.status AS issue_status,h.party_type,h.party_id
		FROM pur_outsourced_issue_item i
		JOIN pur_outsourced_issue h ON h.id=i.issue_id) AS r`
}

func receiptItemSource() string {
	return `FROM (SELECT i.id,i.idx,i.qty,i.base_qty,i.material_code,i.material_name,
		i.material_spec,i.customer_part_no,i.unit_name,i.order_no,i.order_qty,
		i.order_base_qty,i.order_unit_name,i.order_price,i.order_amount,i.order_base_price,
		i.order_base_amount,i.order_tax_rate,i.order_currency_code,i.reconciled_qty,
		i.remarks,i.inserted_at,i.updated_at,i.receipt_id,i.company_id,i.order_item_id,
		i.material_id,i.unit_id,i.warehouse_id,h.receipt_no,h.receipt_date,
		h.status AS receipt_status,h.party_type,h.party_id,
		(i.base_qty-i.reconciled_qty) AS remaining_reconcilable_qty
		FROM pur_outsourced_receipt_item i
		JOIN pur_outsourced_receipt h ON h.id=i.receipt_id) AS r`
}

func receiptMaterialSource() string {
	return `FROM (SELECT c.id,c.idx,c.qty,c.base_qty,c.material_code,c.material_name,
		c.material_spec,c.unit_name,c.order_no,c.remarks,c.inserted_at,c.updated_at,
		c.receipt_item_id,c.company_id,c.order_item_material_id,c.material_id,c.unit_id,
		c.outsourced_warehouse_id,h.receipt_no
		FROM pur_outsourced_receipt_item_material c
		JOIN pur_outsourced_receipt_item i ON i.id=c.receipt_item_id
		JOIN pur_outsourced_receipt h ON h.id=i.receipt_id) AS r`
}

func receiptByproductSource() string {
	return `FROM (SELECT c.id,c.idx,c.qty,c.base_qty,c.material_code,c.material_name,
		c.material_spec,c.unit_name,c.order_no,c.remarks,c.inserted_at,c.updated_at,
		c.receipt_item_id,c.company_id,c.order_item_byproduct_id,c.material_id,c.unit_id,
		c.warehouse_id,h.receipt_no
		FROM pur_outsourced_receipt_item_byproduct c
		JOIN pur_outsourced_receipt_item i ON i.id=c.receipt_item_id
		JOIN pur_outsourced_receipt h ON h.id=i.receipt_id) AS r`
}

func queryIssue(ctx context.Context, db queryer, id uuid.UUID, lock bool) (Issue, error) {
	sql := "SELECT * " + issueSource() + " WHERE id=$1"
	if lock {
		sql += " FOR UPDATE"
	}
	return scanIssue(db.QueryRow(ctx, sql, id))
}

func queryReceipt(ctx context.Context, db queryer, id uuid.UUID, lock bool) (Receipt, error) {
	sql := "SELECT * " + receiptSource() + " WHERE id=$1"
	if lock {
		sql += " FOR UPDATE"
	}
	return scanReceipt(db.QueryRow(ctx, sql, id))
}

func queryIssueItem(ctx context.Context, db queryer, id uuid.UUID, lock bool) (IssueItem, error) {
	sql := "SELECT * " + issueItemSource() + " WHERE id=$1"
	if lock {
		sql += " FOR UPDATE OF r"
	}
	return scanIssueItem(db.QueryRow(ctx, sql, id))
}

func queryReceiptItem(ctx context.Context, db queryer, id uuid.UUID, lock bool) (ReceiptItem, error) {
	sql := "SELECT * " + receiptItemSource() + " WHERE id=$1"
	if lock {
		sql += " FOR UPDATE OF r"
	}
	return scanReceiptItem(db.QueryRow(ctx, sql, id))
}

func queryReceiptMaterial(ctx context.Context, db queryer, id uuid.UUID, lock bool) (ReceiptMaterial, error) {
	sql := "SELECT * " + receiptMaterialSource() + " WHERE id=$1"
	if lock {
		sql += " FOR UPDATE OF r"
	}
	return scanReceiptMaterial(db.QueryRow(ctx, sql, id))
}

func queryReceiptByproduct(ctx context.Context, db queryer, id uuid.UUID, lock bool) (ReceiptByproduct, error) {
	sql := "SELECT * " + receiptByproductSource() + " WHERE id=$1"
	if lock {
		sql += " FOR UPDATE OF r"
	}
	return scanReceiptByproduct(db.QueryRow(ctx, sql, id))
}

func scanIssue(row scanner) (Issue, error) {
	var item Issue
	var dateValue pgtype.Date
	var remarks pgtype.Text
	var auditedAt, insertedAt, updatedAt pgtype.Timestamp
	var status string
	err := row.Scan(&item.ID, &item.IssueNo, &dateValue, &item.PartyType, &item.PartyID,
		&remarks, &status, &auditedAt, &insertedAt, &updatedAt, &item.CompanyID,
		&item.FromWarehouseID, &item.OutsourcedWarehouseID, &item.CreatedByID, &item.AuditedByID)
	item.IssueDate, item.Remarks, item.Status = dateValue.Time, textPtr(remarks), statusFromDB(status)
	item.AuditedAt, item.InsertedAt, item.UpdatedAt = timestampPtr(auditedAt), insertedAt.Time.UTC(), updatedAt.Time.UTC()
	return item, err
}

func scanReceipt(row scanner) (Receipt, error) {
	var item Receipt
	var receiptDate, postingDate pgtype.Date
	var remarks pgtype.Text
	var auditedAt, insertedAt, updatedAt pgtype.Timestamp
	var status string
	err := row.Scan(&item.ID, &item.ReceiptNo, &receiptDate, &postingDate, &item.PartyType,
		&item.PartyID, &remarks, &status, &auditedAt, &insertedAt, &updatedAt,
		&item.CompanyID, &item.WarehouseID, &item.OutsourcedWarehouseID,
		&item.DebitAccountID, &item.CreditAccountID, &item.CreatedByID, &item.AuditedByID)
	item.ReceiptDate, item.PostingDate = receiptDate.Time, datePtr(postingDate)
	item.Remarks, item.Status = textPtr(remarks), statusFromDB(status)
	item.AuditedAt, item.InsertedAt, item.UpdatedAt = timestampPtr(auditedAt), insertedAt.Time.UTC(), updatedAt.Time.UTC()
	return item, err
}

func scanIssueItem(row scanner) (IssueItem, error) {
	var item IssueItem
	var spec, remarks pgtype.Text
	var issueDate pgtype.Date
	var insertedAt, updatedAt pgtype.Timestamp
	var status string
	err := row.Scan(&item.ID, &item.Idx, &item.Qty, &item.BaseQty, &item.MaterialCode,
		&item.MaterialName, &spec, &item.UnitName, &item.OrderNo, &remarks, &insertedAt,
		&updatedAt, &item.IssueID, &item.CompanyID, &item.OrderItemMaterialID,
		&item.MaterialID, &item.UnitID, &item.FromWarehouseID, &item.OutsourcedWarehouseID,
		&item.IssueNo, &issueDate, &status, &item.PartyType, &item.PartyID)
	item.MaterialSpec, item.Remarks, item.IssueDate = textPtr(spec), textPtr(remarks), issueDate.Time
	item.InsertedAt, item.UpdatedAt, item.IssueStatus = insertedAt.Time.UTC(), updatedAt.Time.UTC(), statusFromDB(status)
	return item, err
}

func scanReceiptItem(row scanner) (ReceiptItem, error) {
	var item ReceiptItem
	var spec, partNo, remarks pgtype.Text
	var receiptDate pgtype.Date
	var insertedAt, updatedAt pgtype.Timestamp
	var status string
	err := row.Scan(&item.ID, &item.Idx, &item.Qty, &item.BaseQty, &item.MaterialCode,
		&item.MaterialName, &spec, &partNo, &item.UnitName, &item.OrderNo, &item.OrderQty,
		&item.OrderBaseQty, &item.OrderUnitName, &item.OrderPrice, &item.OrderAmount,
		&item.OrderBasePrice, &item.OrderBaseAmount, &item.OrderTaxRate,
		&item.OrderCurrencyCode, &item.ReconciledQty, &remarks, &insertedAt, &updatedAt,
		&item.ReceiptID, &item.CompanyID, &item.OrderItemID, &item.MaterialID, &item.UnitID,
		&item.WarehouseID, &item.ReceiptNo, &receiptDate, &status, &item.PartyType,
		&item.PartyID, &item.RemainingReconcilableQty)
	item.MaterialSpec, item.CustomerPartNo, item.Remarks = textPtr(spec), textPtr(partNo), textPtr(remarks)
	item.InsertedAt, item.UpdatedAt, item.ReceiptDate = insertedAt.Time.UTC(), updatedAt.Time.UTC(), receiptDate.Time
	item.ReceiptStatus = statusFromDB(status)
	return item, err
}

func scanReceiptMaterial(row scanner) (ReceiptMaterial, error) {
	var item ReceiptMaterial
	var spec, remarks pgtype.Text
	var insertedAt, updatedAt pgtype.Timestamp
	err := row.Scan(&item.ID, &item.Idx, &item.Qty, &item.BaseQty, &item.MaterialCode,
		&item.MaterialName, &spec, &item.UnitName, &item.OrderNo, &remarks, &insertedAt,
		&updatedAt, &item.ReceiptItemID, &item.CompanyID, &item.OrderItemMaterialID,
		&item.MaterialID, &item.UnitID, &item.OutsourcedWarehouseID, &item.ReceiptNo)
	item.MaterialSpec, item.Remarks = textPtr(spec), textPtr(remarks)
	item.InsertedAt, item.UpdatedAt = insertedAt.Time.UTC(), updatedAt.Time.UTC()
	return item, err
}

func scanReceiptByproduct(row scanner) (ReceiptByproduct, error) {
	var item ReceiptByproduct
	var spec, remarks pgtype.Text
	var insertedAt, updatedAt pgtype.Timestamp
	err := row.Scan(&item.ID, &item.Idx, &item.Qty, &item.BaseQty, &item.MaterialCode,
		&item.MaterialName, &spec, &item.UnitName, &item.OrderNo, &remarks, &insertedAt,
		&updatedAt, &item.ReceiptItemID, &item.CompanyID, &item.OrderItemByproductID,
		&item.MaterialID, &item.UnitID, &item.WarehouseID, &item.ReceiptNo)
	item.MaterialSpec, item.Remarks = textPtr(spec), textPtr(remarks)
	item.InsertedAt, item.UpdatedAt = insertedAt.Time.UTC(), updatedAt.Time.UTC()
	return item, err
}
