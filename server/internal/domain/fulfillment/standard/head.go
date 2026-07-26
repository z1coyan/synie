package standard

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/db/dbgen"
	"github.com/z1coyan/synie/server/internal/domain/inventory/stock"
	"github.com/z1coyan/synie/server/internal/domain/trading/order"
	"github.com/z1coyan/synie/server/internal/engines/gl"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/audit"
	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/platform/numbering"
)

var headAuditFields = []string{
	"number", "document_date", "posting_date", "party_type", "party_id", "remarks",
	"status", "audited_at", "company_id", "warehouse_id", "debit_account_id",
	"credit_account_id", "created_by_id", "audited_by_id",
}

func (s *Service) CreateHead(
	ctx context.Context, actor *authz.Actor, side Side, input CreateHeadInput,
) (Head, error) {
	spec, err := specFor(side)
	if err != nil {
		return Head{}, err
	}
	if err := require(actor, spec, "create"); err != nil {
		return Head{}, err
	}
	if actor == nil || !actor.CanAccessCompany(input.CompanyID) {
		return Head{}, apierror.New(apierror.CodeForbidden, "无权在该公司创建履约单")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Head{}, apierror.Wrap(apierror.CodeInternal, "创建"+spec.label+"失败", err)
	}
	defer tx.Rollback(ctx)
	documentDate := todayUTC()
	if input.DocumentDate != nil {
		documentDate = *input.DocumentDate
	}
	number := ""
	if input.No != nil {
		number = strings.TrimSpace(*input.No)
	}
	if number == "" {
		number, err = s.numberer.NextInTx(ctx, tx, numbering.NextInput{
			Resource: spec.numberResource,
			Values: map[string]any{
				"company_id":    input.CompanyID,
				"document_date": documentDate,
			},
		})
		if err != nil {
			return Head{}, err
		}
	}
	var createdByID *uuid.UUID
	if actor.UserID != uuid.Nil {
		createdByID = &actor.UserID
	}
	item := Head{
		No: number, DocumentDate: documentDate, PostingDate: input.PostingDate,
		PartyType: strings.ToLower(strings.TrimSpace(input.PartyType)), PartyID: input.PartyID,
		Remarks: input.Remarks, Status: StatusDraft, CompanyID: input.CompanyID,
		WarehouseID: input.WarehouseID, DebitAccountID: input.DebitAccountID,
		CreditAccountID: input.CreditAccountID, CreatedByID: createdByID,
	}
	if err := validateHeadShape(spec, item); err != nil {
		return Head{}, err
	}
	if err := validateHeadReferences(ctx, tx, spec, item); err != nil {
		return Head{}, err
	}
	var id uuid.UUID
	err = tx.QueryRow(ctx, `INSERT INTO `+spec.headTable+` (
		`+headNoColumn(spec)+`,`+headDateColumn(spec)+`,posting_date,party_type,party_id,
		remarks,status,company_id,warehouse_id,debit_account_id,credit_account_id,created_by_id
	) VALUES ($1,$2,$3,$4,$5,$6,'draft',$7,$8,$9,$10,$11) RETURNING id`,
		item.No, date(item.DocumentDate), nullableDateValue(item.PostingDate), item.PartyType,
		item.PartyID, text(item.Remarks), item.CompanyID, item.WarehouseID,
		item.DebitAccountID, item.CreditAccountID, item.CreatedByID,
	).Scan(&id)
	if err != nil {
		return Head{}, writeError(spec, "创建"+spec.label+"失败", err)
	}
	result, err := queryHeadByID(ctx, tx, spec, id, false)
	if err != nil {
		return Head{}, apierror.Wrap(apierror.CodeInternal, "读取新建"+spec.label+"失败", err)
	}
	if err := writeAudit(ctx, tx, actor, spec.headTable, id, result.No,
		"create", "create", result.CompanyID,
		audit.Created(headSnapshot(result), headAuditFields)); err != nil {
		return Head{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Head{}, writeError(spec, "创建"+spec.label+"失败", err)
	}
	return result, nil
}

func (s *Service) UpdateHead(
	ctx context.Context, actor *authz.Actor, side Side, id uuid.UUID, input UpdateHeadInput,
) (Head, error) {
	spec, err := specFor(side)
	if err != nil {
		return Head{}, err
	}
	if err := require(actor, spec, "update"); err != nil {
		return Head{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Head{}, apierror.Wrap(apierror.CodeInternal, "更新"+spec.label+"失败", err)
	}
	defer tx.Rollback(ctx)
	before, err := lockDraftHead(ctx, tx, actor, spec, id)
	if err != nil {
		return Head{}, err
	}
	after := before
	if input.No != nil {
		after.No = strings.TrimSpace(*input.No)
	}
	if input.DocumentDate != nil {
		after.DocumentDate = *input.DocumentDate
	}
	if input.PostingDate != nil {
		after.PostingDate = *input.PostingDate
	}
	if input.PartyType != nil {
		after.PartyType = strings.ToLower(strings.TrimSpace(*input.PartyType))
	}
	if input.PartyID != nil {
		after.PartyID = *input.PartyID
	}
	if input.Remarks != nil {
		after.Remarks = *input.Remarks
	}
	if input.WarehouseID != nil {
		after.WarehouseID = *input.WarehouseID
	}
	if input.DebitAccountID != nil {
		after.DebitAccountID = *input.DebitAccountID
	}
	if input.CreditAccountID != nil {
		after.CreditAccountID = *input.CreditAccountID
	}
	if before.PartyType != after.PartyType || before.PartyID != after.PartyID {
		parentColumn := "delivery_id"
		if side == SidePurchase {
			parentColumn = "receipt_id"
		}
		var hasItems bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM `+spec.itemTable+
			` WHERE `+parentColumn+`=$1)`, id).Scan(&hasItems); err != nil {
			return Head{}, apierror.Wrap(apierror.CodeInternal, "检查履约条目失败", err)
		}
		if hasItems {
			return Head{}, apierror.New(apierror.CodeConflict, "已有条目时不可修改履约对手")
		}
	}
	if err := validateHeadShape(spec, after); err != nil {
		return Head{}, err
	}
	if err := validateHeadReferences(ctx, tx, spec, after); err != nil {
		return Head{}, err
	}
	changes := audit.Diff(headSnapshot(before), headSnapshot(after), headAuditFields)
	if len(changes) == 0 {
		if err := tx.Commit(ctx); err != nil {
			return Head{}, writeError(spec, "更新"+spec.label+"失败", err)
		}
		return before, nil
	}
	_, err = tx.Exec(ctx, `UPDATE `+spec.headTable+` SET
		`+headNoColumn(spec)+`=$2,`+headDateColumn(spec)+`=$3,posting_date=$4,
		party_type=$5,party_id=$6,remarks=$7,warehouse_id=$8,debit_account_id=$9,
		credit_account_id=$10,updated_at=(now() AT TIME ZONE 'utc') WHERE id=$1`,
		id, after.No, date(after.DocumentDate), nullableDateValue(after.PostingDate),
		after.PartyType, after.PartyID, text(after.Remarks), after.WarehouseID,
		after.DebitAccountID, after.CreditAccountID,
	)
	if err != nil {
		return Head{}, writeError(spec, "更新"+spec.label+"失败", err)
	}
	result, err := queryHeadByID(ctx, tx, spec, id, false)
	if err != nil {
		return Head{}, apierror.Wrap(apierror.CodeInternal, "读取更新后"+spec.label+"失败", err)
	}
	if err := writeAudit(ctx, tx, actor, spec.headTable, id, result.No,
		"update", "update", result.CompanyID, changes); err != nil {
		return Head{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Head{}, writeError(spec, "更新"+spec.label+"失败", err)
	}
	return result, nil
}

func (s *Service) DeleteHead(
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
		return apierror.Wrap(apierror.CodeInternal, "删除"+spec.label+"失败", err)
	}
	defer tx.Rollback(ctx)
	item, err := lockDraftHead(ctx, tx, actor, spec, id)
	if err != nil {
		return err
	}
	parentColumn := "delivery_id"
	if side == SidePurchase {
		parentColumn = "receipt_id"
	}
	if _, err := tx.Exec(ctx, `DELETE FROM sys_attachment WHERE owner_type=$1
		AND owner_id IN (SELECT id FROM `+spec.itemTable+` WHERE `+parentColumn+`=$2)`,
		spec.itemOwnerType, id); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "清理履约条目图纸失败", err)
	}
	if _, err := tx.Exec(ctx, `DELETE FROM `+spec.headTable+` WHERE id=$1`, id); err != nil {
		return writeError(spec, "删除"+spec.label+"失败", err)
	}
	if err := writeAudit(ctx, tx, actor, spec.headTable, id, item.No,
		"destroy", "destroy", item.CompanyID,
		audit.Destroyed(headSnapshot(item), headAuditFields)); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return writeError(spec, "删除"+spec.label+"失败", err)
	}
	return nil
}

func (s *Service) Audit(
	ctx context.Context,
	actor *authz.Actor,
	side Side,
	id uuid.UUID,
	postingDateOverride *time.Time,
) (Head, error) {
	spec, err := specFor(side)
	if err != nil {
		return Head{}, err
	}
	if err := require(actor, spec, "audit"); err != nil {
		return Head{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Head{}, apierror.Wrap(apierror.CodeInternal, "审核"+spec.label+"失败", err)
	}
	defer tx.Rollback(ctx)
	before, err := lockHead(ctx, tx, actor, spec, id)
	if err != nil {
		return Head{}, err
	}
	if before.Status != StatusDraft {
		return Head{}, apierror.New(apierror.CodeConflict, "仅草稿"+spec.label+"可审核")
	}
	if err := validateHeadShape(spec, before); err != nil {
		return Head{}, err
	}
	if err := validateHeadReferences(ctx, tx, spec, before); err != nil {
		return Head{}, err
	}
	items, err := loadActionItems(ctx, tx, spec, id)
	if err != nil {
		return Head{}, err
	}
	if len(items) == 0 {
		return Head{}, apierror.New(apierror.CodeConflict, "审核前必须至少填写一条履约条目")
	}
	projectionLines := make([]order.FulfillmentLine, 0, len(items))
	stockLines := make([]stock.Line, 0, len(items))
	amount := decimal.Zero
	for _, item := range items {
		projectionLines = append(projectionLines, order.FulfillmentLine{
			OrderItemID: item.OrderItemID, BaseQty: item.BaseQty,
		})
		quantity := item.BaseQty.Mul(decimal.NewFromInt(spec.stockDirection))
		stockLines = append(stockLines, stock.Line{
			WarehouseID: item.WarehouseID, MaterialID: item.MaterialID,
			Quantity: quantity, Remarks: before.Remarks,
		})
		if !item.OrderBaseQty.IsZero() {
			amount = amount.Add(item.OrderBaseAmount.Mul(item.BaseQty).Div(item.OrderBaseQty))
		}
	}
	amount = amount.Round(2)
	orderSide := order.SideSales
	if side == SidePurchase {
		orderSide = order.SidePurchase
	}
	if err := s.orders.PostFulfillment(ctx, tx, orderSide, order.FulfillmentInput{
		CompanyID: before.CompanyID, PartyType: before.PartyType, PartyID: before.PartyID,
		Lines: projectionLines,
	}); err != nil {
		return Head{}, err
	}
	if err := stock.Post(ctx, tx, stock.Voucher{
		Type: spec.voucherType, ID: before.ID, No: before.No,
		CompanyID: before.CompanyID, PostingDate: before.DocumentDate,
	}, stockLines); err != nil {
		return Head{}, err
	}
	postingDate := before.DocumentDate
	if before.PostingDate != nil {
		postingDate = *before.PostingDate
	}
	if postingDateOverride != nil {
		postingDate = *postingDateOverride
	}
	if amount.GreaterThan(decimal.Zero) {
		debitCurrency, creditCurrency, err := accountCurrencies(
			ctx, tx, before.DebitAccountID, before.CreditAccountID,
		)
		if err != nil {
			return Head{}, err
		}
		partyType, partyID := before.PartyType, before.PartyID
		debit := gl.Entry{
			AccountID: before.DebitAccountID, CurrencyID: debitCurrency,
			Debit: amount, Credit: decimal.Zero,
		}
		credit := gl.Entry{
			AccountID: before.CreditAccountID, CurrencyID: creditCurrency,
			Debit: decimal.Zero, Credit: amount,
		}
		if side == SideSales {
			debit.PartyType, debit.PartyID = &partyType, &partyID
		} else {
			credit.PartyType, credit.PartyID = &partyType, &partyID
		}
		if err := gl.Post(ctx, tx, gl.Voucher{
			Type: spec.voucherType, ID: before.ID, No: before.No,
			CompanyID: before.CompanyID, PostingDate: postingDate,
		}, []gl.Entry{debit, credit}); err != nil {
			return Head{}, err
		}
	}
	now := time.Now().UTC()
	var auditedByID *uuid.UUID
	if actor.UserID != uuid.Nil {
		auditedByID = &actor.UserID
	}
	_, err = tx.Exec(ctx, `UPDATE `+spec.headTable+` SET status='audited',posting_date=$2,
		audited_at=$3,audited_by_id=$4,updated_at=$3 WHERE id=$1`,
		id, date(postingDate), timestamp(now), auditedByID)
	if err != nil {
		return Head{}, writeError(spec, "审核"+spec.label+"失败", err)
	}
	result, err := queryHeadByID(ctx, tx, spec, id, false)
	if err != nil {
		return Head{}, apierror.Wrap(apierror.CodeInternal, "读取审核后"+spec.label+"失败", err)
	}
	if err := writeAudit(ctx, tx, actor, spec.headTable, id, result.No,
		"update", "audit", result.CompanyID,
		audit.Diff(headSnapshot(before), headSnapshot(result), headAuditFields)); err != nil {
		return Head{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Head{}, writeError(spec, "审核"+spec.label+"失败", err)
	}
	return result, nil
}

func (s *Service) Void(
	ctx context.Context, actor *authz.Actor, side Side, id uuid.UUID,
) (Head, error) {
	spec, err := specFor(side)
	if err != nil {
		return Head{}, err
	}
	if err := require(actor, spec, "void"); err != nil {
		return Head{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Head{}, apierror.Wrap(apierror.CodeInternal, "作废"+spec.label+"失败", err)
	}
	defer tx.Rollback(ctx)
	before, err := lockHead(ctx, tx, actor, spec, id)
	if err != nil {
		return Head{}, err
	}
	if before.Status != StatusAudited {
		return Head{}, apierror.New(apierror.CodeConflict, "仅已审核"+spec.label+"可作废")
	}
	items, err := loadActionItems(ctx, tx, spec, id)
	if err != nil {
		return Head{}, err
	}
	for _, item := range items {
		if item.ReconciledQty.GreaterThan(decimal.Zero) {
			return Head{}, apierror.New(apierror.CodeConflict, "存在已对账履约条目,不可作废")
		}
	}
	projectionLines := make([]order.FulfillmentLine, 0, len(items))
	for _, item := range items {
		projectionLines = append(projectionLines, order.FulfillmentLine{
			OrderItemID: item.OrderItemID, BaseQty: item.BaseQty,
		})
	}
	orderSide := order.SideSales
	if side == SidePurchase {
		orderSide = order.SidePurchase
	}
	if err := s.orders.ReverseFulfillment(ctx, tx, orderSide, order.FulfillmentInput{
		CompanyID: before.CompanyID, PartyType: before.PartyType, PartyID: before.PartyID,
		Lines: projectionLines,
	}); err != nil {
		return Head{}, err
	}
	if err := stock.Cancel(ctx, tx, stock.VoucherRef{
		Type: spec.voucherType, ID: before.ID,
	}, time.Now().UTC()); err != nil {
		return Head{}, err
	}
	if err := gl.Cancel(ctx, tx, gl.VoucherRef{Type: spec.voucherType, ID: before.ID}); err != nil {
		return Head{}, err
	}
	now := time.Now().UTC()
	if _, err := tx.Exec(ctx, `UPDATE `+spec.headTable+`
		SET status='voided',updated_at=$2 WHERE id=$1`, id, timestamp(now)); err != nil {
		return Head{}, writeError(spec, "作废"+spec.label+"失败", err)
	}
	result, err := queryHeadByID(ctx, tx, spec, id, false)
	if err != nil {
		return Head{}, apierror.Wrap(apierror.CodeInternal, "读取作废后"+spec.label+"失败", err)
	}
	if err := writeAudit(ctx, tx, actor, spec.headTable, id, result.No,
		"update", "void", result.CompanyID,
		audit.Diff(headSnapshot(before), headSnapshot(result), headAuditFields)); err != nil {
		return Head{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Head{}, writeError(spec, "作废"+spec.label+"失败", err)
	}
	return result, nil
}

func lockHead(
	ctx context.Context, tx pgx.Tx, actor *authz.Actor, spec sideSpec, id uuid.UUID,
) (Head, error) {
	q := dbgen.New(tx)
	var item Head
	var err error
	if spec.side == SideSales {
		var row dbgen.SalDelivery
		row, err = q.LockSalDelivery(ctx, id)
		if err == nil {
			item = headFromSalesRow(row)
		}
	} else {
		var row dbgen.PurReceipt
		row, err = q.LockPurReceipt(ctx, id)
		if err == nil {
			item = headFromPurchaseRow(row)
		}
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return Head{}, apierror.New(apierror.CodeNotFound, spec.label+"不存在")
	}
	if err != nil {
		return Head{}, apierror.Wrap(apierror.CodeInternal, "锁定"+spec.label+"失败", err)
	}
	if err := requireCompany(actor, item.CompanyID, spec.label+"不存在"); err != nil {
		return Head{}, err
	}
	return item, nil
}

func lockDraftHead(
	ctx context.Context, tx pgx.Tx, actor *authz.Actor, spec sideSpec, id uuid.UUID,
) (Head, error) {
	item, err := lockHead(ctx, tx, actor, spec, id)
	if err != nil {
		return Head{}, err
	}
	if item.Status != StatusDraft {
		return Head{}, apierror.New(apierror.CodeConflict, "仅草稿"+spec.label+"可编辑")
	}
	return item, nil
}

func loadActionItems(
	ctx context.Context, tx pgx.Tx, spec sideSpec, headID uuid.UUID,
) ([]Item, error) {
	parentColumn := "delivery_id"
	if spec.side == SidePurchase {
		parentColumn = "receipt_id"
	}
	rows, err := tx.Query(ctx, `SELECT id FROM `+spec.itemTable+`
		WHERE `+parentColumn+`=$1 ORDER BY idx,id`, headID)
	if err != nil {
		return nil, apierror.Wrap(apierror.CodeInternal, "读取履约条目失败", err)
	}
	ids := make([]uuid.UUID, 0)
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, apierror.Wrap(apierror.CodeInternal, "读取履约条目失败", err)
		}
		ids = append(ids, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, apierror.Wrap(apierror.CodeInternal, "遍历履约条目失败", err)
	}
	items := make([]Item, 0, len(ids))
	for _, id := range ids {
		item, err := queryItemByID(ctx, tx, spec, id, true)
		if err != nil {
			return nil, apierror.Wrap(apierror.CodeInternal, "锁定履约条目失败", err)
		}
		items = append(items, item)
	}
	return items, nil
}

func accountCurrencies(
	ctx context.Context, tx pgx.Tx, debitID, creditID uuid.UUID,
) (*uuid.UUID, *uuid.UUID, error) {
	currencies := make(map[uuid.UUID]*uuid.UUID, 2)
	rows, err := tx.Query(ctx, `SELECT id,currency_id FROM bas_account
		WHERE id=ANY($1::uuid[])`, []uuid.UUID{debitID, creditID})
	if err != nil {
		return nil, nil, apierror.Wrap(apierror.CodeInternal, "读取履约科目币种失败", err)
	}
	for rows.Next() {
		var id uuid.UUID
		var currencyID *uuid.UUID
		if err := rows.Scan(&id, &currencyID); err != nil {
			rows.Close()
			return nil, nil, apierror.Wrap(apierror.CodeInternal, "读取履约科目币种失败", err)
		}
		currencies[id] = currencyID
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, nil, apierror.Wrap(apierror.CodeInternal, "遍历履约科目币种失败", err)
	}
	return currencies[debitID], currencies[creditID], nil
}

func nullableDateValue(value *time.Time) pgtype.Date {
	if value == nil {
		return pgtype.Date{}
	}
	return date(*value)
}

func headSnapshot(item Head) map[string]any {
	return map[string]any{
		"number": item.No, "document_date": item.DocumentDate, "posting_date": item.PostingDate,
		"party_type": item.PartyType, "party_id": item.PartyID, "remarks": item.Remarks,
		"status": item.Status, "audited_at": item.AuditedAt, "company_id": item.CompanyID,
		"warehouse_id": item.WarehouseID, "debit_account_id": item.DebitAccountID,
		"credit_account_id": item.CreditAccountID, "created_by_id": item.CreatedByID,
		"audited_by_id": item.AuditedByID,
	}
}
