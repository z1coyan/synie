package reconciliation

import (
	"context"
	"errors"
	"fmt"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
	"github.com/z1coyan/synie/server/internal/db/pgconv"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/audit"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

type sourceItem struct {
	id, companyID, partyID, orderID                                        uuid.UUID
	partyType, status, no, materialName, unitName, currencyCode, orderType string
	sourceDate                                                             time.Time
	qty, baseQty, reconciledQty, price, exchangeRate                       decimal.Decimal
	outsourced                                                             bool
}

func (s *Service) CreateItem(
	ctx context.Context, actor *authz.Actor, side Side, input CreateItemInput,
) (Item, error) {
	spec, err := specFor(side)
	if err != nil {
		return Item{}, err
	}
	if err := require(actor, spec, "create"); err != nil {
		return Item{}, err
	}
	if err := validateItemShape(spec, input); err != nil {
		return Item{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Item{}, apierror.Wrap(apierror.CodeInternal, "创建对账条目失败", err)
	}
	defer tx.Rollback(ctx)
	head, err := lockHead(ctx, tx, actor, spec, input.ReconciliationID)
	if err != nil {
		return Item{}, err
	}
	if head.Status != StatusDraft {
		return Item{}, apierror.New(apierror.CodeConflict, "仅草稿对账单可编辑条目")
	}
	source, err := loadSource(ctx, tx, side, input, true)
	if err != nil {
		return Item{}, err
	}
	if err := validateSource(ctx, tx, spec, head, source, uuid.Nil, input.Qty); err != nil {
		return Item{}, err
	}
	baseQty, amount, baseAmount := snapshotAmounts(input.Qty, source)
	id := uuid.New()
	if side == SideSales {
		_, err = tx.Exec(ctx, `INSERT INTO sal_reconciliation_item
			(id,idx,qty,base_qty,amount,base_amount,remarks,reconciliation_id,
			 company_id,delivery_item_id)
			VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
			id, input.Idx, input.Qty, baseQty, amount, baseAmount, pgconv.OptionalText(input.Remarks),
			head.ID, head.CompanyID, source.id)
	} else {
		_, err = tx.Exec(ctx, `INSERT INTO pur_reconciliation_item
			(id,idx,qty,base_qty,amount,base_amount,remarks,reconciliation_id,
			 company_id,receipt_item_id,outsourced_receipt_item_id)
			VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
			id, input.Idx, input.Qty, baseQty, amount, baseAmount, pgconv.OptionalText(input.Remarks),
			head.ID, head.CompanyID, input.ReceiptItemID, input.OutsourcedReceiptItemID)
	}
	if err != nil {
		return Item{}, writeError("创建对账条目失败", err)
	}
	result, err := queryItem(ctx, tx, spec, id)
	if err != nil {
		return Item{}, err
	}
	if err := audit.Write(ctx, tx, actor, audit.Entry{
		Resource: spec.itemTable, RecordID: id, RecordLabel: fmt.Sprintf("%s-%d", head.No, result.Idx),
		ActionType: "create", ActionName: "create", CompanyID: &head.CompanyID,
		Changes: audit.Created(itemSnapshot(result), itemAuditFields),
	}); err != nil {
		return Item{}, apierror.Wrap(apierror.CodeInternal, "创建对账条目失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return Item{}, writeError("创建对账条目失败", err)
	}
	return result, nil
}

func validateItemShape(spec sideSpec, input CreateItemInput) error {
	fields := map[string][]string{}
	if input.ReconciliationID == uuid.Nil {
		fields["reconciliationId"] = []string{"必填"}
	}
	if !input.Qty.GreaterThan(decimal.Zero) {
		fields["qty"] = []string{"必须大于 0"}
	}
	if input.Remarks != nil && utf8.RuneCountInString(*input.Remarks) > 512 {
		fields["remarks"] = []string{"最多 512 个字符"}
	}
	if spec.side == "sales" {
		if input.DeliveryItemID == nil || *input.DeliveryItemID == uuid.Nil {
			fields["deliveryItemId"] = []string{"必填"}
		}
		if input.ReceiptItemID != nil || input.OutsourcedReceiptItemID != nil {
			fields["source"] = []string{"销售对账只允许发货条目来源"}
		}
	} else {
		count := 0
		if input.ReceiptItemID != nil && *input.ReceiptItemID != uuid.Nil {
			count++
		}
		if input.OutsourcedReceiptItemID != nil && *input.OutsourcedReceiptItemID != uuid.Nil {
			count++
		}
		if count != 1 {
			fields["source"] = []string{"标准入库条目与委外入库条目必须恰选一个"}
		}
		if input.DeliveryItemID != nil {
			fields["deliveryItemId"] = []string{"采购对账不允许发货条目来源"}
		}
	}
	if len(fields) > 0 {
		return apierror.Validation("对账条目参数不合法", fields)
	}
	return nil
}

func loadSource(
	ctx context.Context, tx pgx.Tx, side Side, input CreateItemInput, lock bool,
) (sourceItem, error) {
	lockSQL := ""
	if lock {
		lockSQL = " FOR UPDATE OF i"
	}
	var row pgx.Row
	if side == SideSales {
		row = tx.QueryRow(ctx, `SELECT i.id,h.company_id,h.party_type,h.party_id,h.status,
			h.delivery_no,h.delivery_date,i.material_name,i.unit_name,i.order_currency_code,
			i.qty,i.base_qty,i.reconciled_qty,i.order_price,o.exchange_rate,o.order_type,o.id
			FROM sal_delivery_item i JOIN sal_delivery h ON h.id=i.delivery_id
			JOIN sal_order_item oi ON oi.id=i.order_item_id
			JOIN sal_order o ON o.id=oi.order_id WHERE i.id=$1`+lockSQL, *input.DeliveryItemID)
	} else if input.ReceiptItemID != nil {
		row = tx.QueryRow(ctx, `SELECT i.id,h.company_id,h.party_type,h.party_id,h.status,
			h.receipt_no,h.receipt_date,i.material_name,i.unit_name,i.order_currency_code,
			i.qty,i.base_qty,i.reconciled_qty,i.order_price,o.exchange_rate,o.order_type,o.id
			FROM pur_receipt_item i JOIN pur_receipt h ON h.id=i.receipt_id
			JOIN pur_order_item oi ON oi.id=i.order_item_id
			JOIN pur_order o ON o.id=oi.order_id WHERE i.id=$1`+lockSQL, *input.ReceiptItemID)
	} else {
		row = tx.QueryRow(ctx, `SELECT i.id,h.company_id,h.party_type,h.party_id,h.status,
			h.receipt_no,h.receipt_date,i.material_name,i.unit_name,i.order_currency_code,
			i.qty,i.base_qty,i.reconciled_qty,i.order_price,o.exchange_rate,o.order_type,o.id
			FROM pur_outsourced_receipt_item i
			JOIN pur_outsourced_receipt h ON h.id=i.receipt_id
			JOIN pur_order_item oi ON oi.id=i.order_item_id
			JOIN pur_order o ON o.id=oi.order_id WHERE i.id=$1`+lockSQL,
			*input.OutsourcedReceiptItemID)
	}
	var source sourceItem
	var sourceDate pgtype.Date
	err := row.Scan(&source.id, &source.companyID, &source.partyType, &source.partyID,
		&source.status, &source.no, &sourceDate, &source.materialName, &source.unitName,
		&source.currencyCode, &source.qty, &source.baseQty, &source.reconciledQty,
		&source.price, &source.exchangeRate, &source.orderType, &source.orderID)
	if errors.Is(err, pgx.ErrNoRows) {
		return sourceItem{}, apierror.Validation("对账条目参数不合法",
			map[string][]string{"source": {"来源条目不存在"}})
	}
	if err != nil {
		return sourceItem{}, apierror.Wrap(apierror.CodeInternal, "读取对账来源失败", err)
	}
	source.sourceDate = sourceDate.Time
	source.outsourced = side == SidePurchase && input.OutsourcedReceiptItemID != nil
	return source, nil
}

func validateSource(
	ctx context.Context, tx pgx.Tx, spec sideSpec, head Head, source sourceItem,
	selfID uuid.UUID, qty decimal.Decimal,
) error {
	if source.status != "audited" {
		return apierror.New(apierror.CodeConflict, "仅已审核且未作废的来源条目可对账")
	}
	if source.companyID != head.CompanyID {
		return apierror.Validation("对账条目参数不合法",
			map[string][]string{"source": {"来源公司与对账单不一致"}})
	}
	if source.partyType != head.PartyType || source.partyID != head.PartyID {
		return apierror.Validation("对账条目参数不合法",
			map[string][]string{"source": {"来源对手与对账单不一致"}})
	}
	var siblingCurrency *string
	query := `SELECT CASE
		WHEN $1='sales' THEN (SELECT di.order_currency_code FROM sal_reconciliation_item ri
			JOIN sal_delivery_item di ON di.id=ri.delivery_item_id
			WHERE ri.reconciliation_id=$2 AND ri.id<>$3 LIMIT 1)
		ELSE (SELECT COALESCE(si.order_currency_code,oi.order_currency_code)
			FROM pur_reconciliation_item ri
			LEFT JOIN pur_receipt_item si ON si.id=ri.receipt_item_id
			LEFT JOIN pur_outsourced_receipt_item oi ON oi.id=ri.outsourced_receipt_item_id
			WHERE ri.reconciliation_id=$2 AND ri.id<>$3 LIMIT 1) END`
	if err := tx.QueryRow(ctx, query, spec.side, head.ID, selfID).Scan(&siblingCurrency); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "校验对账币种失败", err)
	}
	if siblingCurrency != nil && *siblingCurrency != source.currencyCode {
		return apierror.Validation("对账条目参数不合法",
			map[string][]string{"source": {"同一对账单内订单原币必须一致"}})
	}
	if head.Kind == KindRegular {
		if !source.price.GreaterThan(decimal.Zero) {
			return apierror.Validation("对账条目参数不合法",
				map[string][]string{"source": {"常规对账单不可勾选零金额条目"}})
		}
		if spec.side == "sales" && source.orderType == "sample" {
			return apierror.Validation("对账条目参数不合法",
				map[string][]string{"source": {"常规销售对账单不可勾选样品订单来源"}})
		}
	}
	baseQty, _, _ := snapshotAmounts(qty, source)
	remaining := source.baseQty.Sub(source.reconciledQty)
	if baseQty.GreaterThan(remaining) {
		return apierror.New(apierror.CodeConflict,
			"超出剩余可对账量(剩余 "+remaining.String()+")")
	}
	return nil
}

func snapshotAmounts(qty decimal.Decimal, source sourceItem) (
	decimal.Decimal, decimal.Decimal, decimal.Decimal,
) {
	baseQty := qty
	if !source.qty.IsZero() {
		baseQty = qty.Mul(source.baseQty).Div(source.qty).Round(6)
	}
	amount := qty.Mul(source.price).Round(2)
	return baseQty, amount, amount.Mul(source.exchangeRate).Round(2)
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
	item, err := queryItem(ctx, s.pool, spec, id)
	if err != nil {
		return Item{}, err
	}
	if err := requireCompany(actor, item.CompanyID, "对账条目"); err != nil {
		return Item{}, err
	}
	return item, nil
}

func (s *Service) ListItems(
	ctx context.Context, actor *authz.Actor, side Side, query ListQuery,
) (ItemList, error) {
	spec, err := specFor(side)
	if err != nil {
		return ItemList{}, err
	}
	if err := require(actor, spec, "read"); err != nil {
		return ItemList{}, err
	}
	if err := validatePage(&query); err != nil {
		return ItemList{}, err
	}
	built, err := filterbuild.Build(ItemResourceMeta(side), filterbuild.Query{
		Limit: query.Limit, Offset: query.Offset, Search: query.Search,
		Sort: query.Sort, Filter: query.Filter,
	})
	if err != nil {
		return ItemList{}, err
	}
	where, args := scopedWhere(actor, built.Where, append([]any(nil), built.Args...))
	orderBy := built.OrderBy
	if orderBy == "" {
		orderBy = ` ORDER BY "idx" ASC,"id" ASC`
	} else {
		orderBy += `,"id" ASC`
	}
	source := itemSource(spec)
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{
		IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return ItemList{}, apierror.Wrap(apierror.CodeInternal, "查询对账条目失败", err)
	}
	defer tx.Rollback(ctx)
	var result ItemList
	if err := tx.QueryRow(ctx, `SELECT COUNT(*)`+source+where, args...).
		Scan(&result.Count); err != nil {
		return ItemList{}, apierror.Wrap(apierror.CodeInternal, "统计对账条目失败", err)
	}
	limitAt := len(args) + 1
	args = append(args, query.Limit, query.Offset)
	sql := itemSelect(spec) + source + where + orderBy +
		fmt.Sprintf(" LIMIT $%d OFFSET $%d", limitAt, limitAt+1)
	rows, err := tx.Query(ctx, sql, args...)
	if err != nil {
		return ItemList{}, apierror.Wrap(apierror.CodeInternal, "读取对账条目失败", err)
	}
	defer rows.Close()
	for rows.Next() {
		item, scanErr := scanItem(rows)
		if scanErr != nil {
			return ItemList{}, apierror.Wrap(apierror.CodeInternal, "读取对账条目失败", scanErr)
		}
		result.Results = append(result.Results, item)
	}
	if err := rows.Err(); err != nil {
		return ItemList{}, apierror.Wrap(apierror.CodeInternal, "读取对账条目失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return ItemList{}, apierror.Wrap(apierror.CodeInternal, "完成对账条目查询失败", err)
	}
	return result, nil
}

func itemSelect(spec sideSpec) string {
	sourceNo := "receipt_no"
	if spec.side == "sales" {
		sourceNo = "delivery_no"
	}
	return `SELECT id,idx,qty,base_qty,amount,base_amount,remarks,inserted_at,
		updated_at,reconciliation_id,company_id,delivery_item_id,receipt_item_id,
		outsourced_receipt_item_id,reconciliation_no,reconciliation_status,` +
		sourceNo + `,source_date,material_name,unit_name,order_currency_code,
		source_reconciled_qty,source_remaining_reconcile_qty`
}

func itemSource(spec sideSpec) string {
	if spec.side == "sales" {
		return ` FROM (SELECT ri.id,ri.idx,ri.qty,ri.base_qty,ri.amount,ri.base_amount,
			ri.remarks,ri.inserted_at,ri.updated_at,ri.reconciliation_id,ri.company_id,
			ri.delivery_item_id,NULL::uuid AS receipt_item_id,
			NULL::uuid AS outsourced_receipt_item_id,r.reconciliation_no,
			r.status AS reconciliation_status,h.delivery_no,h.delivery_date,
			h.delivery_date AS source_date,i.material_name,i.unit_name,
			i.order_currency_code,i.reconciled_qty AS source_reconciled_qty,
			(i.base_qty-i.reconciled_qty) AS source_remaining_reconcile_qty
			FROM sal_reconciliation_item ri
			JOIN sal_reconciliation r ON r.id=ri.reconciliation_id
			JOIN sal_delivery_item i ON i.id=ri.delivery_item_id
			JOIN sal_delivery h ON h.id=i.delivery_id) reconciliation_items`
	}
	return ` FROM (SELECT ri.id,ri.idx,ri.qty,ri.base_qty,ri.amount,ri.base_amount,
		ri.remarks,ri.inserted_at,ri.updated_at,ri.reconciliation_id,ri.company_id,
		NULL::uuid AS delivery_item_id,ri.receipt_item_id,ri.outsourced_receipt_item_id,
		r.reconciliation_no,r.status AS reconciliation_status,
		COALESCE(sh.receipt_no,oh.receipt_no) AS receipt_no,
		COALESCE(sh.receipt_date,oh.receipt_date) AS receipt_date,
		COALESCE(sh.receipt_date,oh.receipt_date) AS source_date,
		COALESCE(si.material_name,oi.material_name) AS material_name,
		COALESCE(si.unit_name,oi.unit_name) AS unit_name,
		COALESCE(si.order_currency_code,oi.order_currency_code) AS order_currency_code,
		COALESCE(si.reconciled_qty,oi.reconciled_qty) AS source_reconciled_qty,
		COALESCE(si.base_qty-si.reconciled_qty,oi.base_qty-oi.reconciled_qty)
			AS source_remaining_reconcile_qty
		FROM pur_reconciliation_item ri
		JOIN pur_reconciliation r ON r.id=ri.reconciliation_id
		LEFT JOIN pur_receipt_item si ON si.id=ri.receipt_item_id
		LEFT JOIN pur_receipt sh ON sh.id=si.receipt_id
		LEFT JOIN pur_outsourced_receipt_item oi ON oi.id=ri.outsourced_receipt_item_id
		LEFT JOIN pur_outsourced_receipt oh ON oh.id=oi.receipt_id) reconciliation_items`
}

func scanItem(row pgx.Row) (Item, error) {
	var item Item
	var sourceDate pgtype.Date
	err := row.Scan(&item.ID, &item.Idx, &item.Qty, &item.BaseQty, &item.Amount,
		&item.BaseAmount, &item.Remarks, &item.InsertedAt, &item.UpdatedAt,
		&item.ReconciliationID, &item.CompanyID, &item.DeliveryItemID,
		&item.ReceiptItemID, &item.OutsourcedReceiptItemID, &item.ReconciliationNo,
		&item.ReconciliationStatus, &item.SourceNo, &sourceDate, &item.MaterialName,
		&item.UnitName, &item.OrderCurrencyCode,
		&item.SourceReconciledQty, &item.SourceRemainingReconcileQty)
	item.SourceDate = sourceDate.Time
	return item, err
}

func queryItem(
	ctx context.Context, db interface {
		QueryRow(context.Context, string, ...any) pgx.Row
	}, spec sideSpec, id uuid.UUID,
) (Item, error) {
	item, err := scanItem(db.QueryRow(ctx, itemSelect(spec)+itemSource(spec)+` WHERE id=$1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return Item{}, apierror.New(apierror.CodeNotFound, "对账条目不存在")
	}
	if err != nil {
		return Item{}, apierror.Wrap(apierror.CodeInternal, "读取对账条目失败", err)
	}
	return item, nil
}

func (s *Service) UpdateItem(
	ctx context.Context, actor *authz.Actor, side Side, id uuid.UUID, input UpdateItemInput,
) (Item, error) {
	spec, err := specFor(side)
	if err != nil {
		return Item{}, err
	}
	if err := require(actor, spec, "update"); err != nil {
		return Item{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Item{}, apierror.Wrap(apierror.CodeInternal, "更新对账条目失败", err)
	}
	defer tx.Rollback(ctx)
	before, err := queryItem(ctx, tx, spec, id)
	if err != nil {
		return Item{}, err
	}
	head, err := lockHead(ctx, tx, actor, spec, before.ReconciliationID)
	if err != nil {
		return Item{}, err
	}
	if head.Status != StatusDraft {
		return Item{}, apierror.New(apierror.CodeConflict, "仅草稿对账单可编辑条目")
	}
	create := CreateItemInput{
		ReconciliationID: head.ID, Idx: before.Idx, Qty: before.Qty,
		DeliveryItemID: before.DeliveryItemID, ReceiptItemID: before.ReceiptItemID,
		OutsourcedReceiptItemID: before.OutsourcedReceiptItemID, Remarks: before.Remarks,
	}
	if input.Idx != nil {
		create.Idx = *input.Idx
	}
	if input.Qty != nil {
		create.Qty = *input.Qty
	}
	if input.DeliveryItemID.Set {
		create.DeliveryItemID = input.DeliveryItemID.Value
	}
	if input.ReceiptItemID.Set {
		create.ReceiptItemID = input.ReceiptItemID.Value
	}
	if input.OutsourcedReceiptItemID.Set {
		create.OutsourcedReceiptItemID = input.OutsourcedReceiptItemID.Value
	}
	if input.Remarks.Set {
		create.Remarks = input.Remarks.Value
	}
	if err := validateItemShape(spec, create); err != nil {
		return Item{}, err
	}
	source, err := loadSource(ctx, tx, side, create, true)
	if err != nil {
		return Item{}, err
	}
	if err := validateSource(ctx, tx, spec, head, source, id, create.Qty); err != nil {
		return Item{}, err
	}
	baseQty, amount, baseAmount := snapshotAmounts(create.Qty, source)
	if side == SideSales {
		_, err = tx.Exec(ctx, `UPDATE sal_reconciliation_item SET idx=$2,qty=$3,
			base_qty=$4,amount=$5,base_amount=$6,remarks=$7,delivery_item_id=$8,
			updated_at=(now() AT TIME ZONE 'utc') WHERE id=$1`,
			id, create.Idx, create.Qty, baseQty, amount, baseAmount,
			pgconv.OptionalText(create.Remarks), create.DeliveryItemID)
	} else {
		_, err = tx.Exec(ctx, `UPDATE pur_reconciliation_item SET idx=$2,qty=$3,
			base_qty=$4,amount=$5,base_amount=$6,remarks=$7,receipt_item_id=$8,
			outsourced_receipt_item_id=$9,updated_at=(now() AT TIME ZONE 'utc') WHERE id=$1`,
			id, create.Idx, create.Qty, baseQty, amount, baseAmount,
			pgconv.OptionalText(create.Remarks), create.ReceiptItemID, create.OutsourcedReceiptItemID)
	}
	if err != nil {
		return Item{}, writeError("更新对账条目失败", err)
	}
	result, err := queryItem(ctx, tx, spec, id)
	if err != nil {
		return Item{}, err
	}
	changes := audit.Diff(itemSnapshot(before), itemSnapshot(result), itemAuditFields)
	if len(changes) > 0 {
		if err := audit.Write(ctx, tx, actor, audit.Entry{
			Resource: spec.itemTable, RecordID: id,
			RecordLabel: fmt.Sprintf("%s-%d", head.No, result.Idx),
			ActionType:  "update", ActionName: "update", CompanyID: &head.CompanyID,
			Changes: changes,
		}); err != nil {
			return Item{}, apierror.Wrap(apierror.CodeInternal, "更新对账条目失败", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return Item{}, writeError("更新对账条目失败", err)
	}
	return result, nil
}

func (s *Service) DeleteItem(
	ctx context.Context, actor *authz.Actor, side Side, id uuid.UUID,
) error {
	spec, err := specFor(side)
	if err != nil {
		return err
	}
	if err := require(actor, spec, "delete"); err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除对账条目失败", err)
	}
	defer tx.Rollback(ctx)
	before, err := queryItem(ctx, tx, spec, id)
	if err != nil {
		return err
	}
	head, err := lockHead(ctx, tx, actor, spec, before.ReconciliationID)
	if err != nil {
		return err
	}
	if head.Status != StatusDraft {
		return apierror.New(apierror.CodeConflict, "仅草稿对账单可编辑条目")
	}
	if err := audit.Write(ctx, tx, actor, audit.Entry{
		Resource: spec.itemTable, RecordID: id,
		RecordLabel: fmt.Sprintf("%s-%d", head.No, before.Idx),
		ActionType:  "destroy", ActionName: "destroy", CompanyID: &head.CompanyID,
		Changes: audit.Destroyed(itemSnapshot(before), itemAuditFields),
	}); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除对账条目失败", err)
	}
	if _, err := tx.Exec(ctx, `DELETE FROM `+spec.itemTable+` WHERE id=$1`, id); err != nil {
		return writeError("删除对账条目失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return writeError("删除对账条目失败", err)
	}
	return nil
}
