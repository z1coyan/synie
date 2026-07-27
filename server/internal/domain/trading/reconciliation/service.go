// Package reconciliation implements the sales and purchase reconciliation
// workflows behind one symmetric interface. The caller only selects a side;
// source locking, amount snapshots, projections, todos, GL and audit remain
// local to this module.
package reconciliation

import (
	"context"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/z1coyan/synie/server/internal/db/pgconv"
	"github.com/z1coyan/synie/server/internal/domain/fulfillment/outsourced"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/audit"
	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/platform/dberr"
	"github.com/z1coyan/synie/server/internal/platform/numbering"
)

type Numberer interface {
	NextInTx(context.Context, pgx.Tx, numbering.NextInput) (string, error)
}

type Service struct {
	pool       *pgxpool.Pool
	numberer   Numberer
	outsourced *outsourced.Service
}

func NewService(pool *pgxpool.Pool, numberers ...Numberer) *Service {
	var numberer Numberer = numbering.NewService(pool)
	if len(numberers) > 0 && numberers[0] != nil {
		numberer = numberers[0]
	}
	return &Service{
		pool: pool, numberer: numberer, outsourced: outsourced.NewService(pool),
	}
}

type sideSpec struct {
	side, prefix, table, itemTable, label, party, todoType, voucher string
}

func specFor(side Side) (sideSpec, error) {
	switch side {
	case SideSales:
		return sideSpec{
			side: "sales", prefix: "sales.reconciliation",
			table: "sal_reconciliation", itemTable: "sal_reconciliation_item",
			label: "销售对账单", party: "customer", todoType: "issue_invoice",
			voucher: "sales.reconciliation",
		}, nil
	case SidePurchase:
		return sideSpec{
			side: "purchase", prefix: "purchase.reconciliation",
			table: "pur_reconciliation", itemTable: "pur_reconciliation_item",
			label: "采购对账单", party: "supplier", todoType: "receive_invoice",
			voucher: "purchase.reconciliation",
		}, nil
	default:
		return sideSpec{}, apierror.Validation("对账方向不合法",
			map[string][]string{"side": {"只允许 sales 或 purchase"}})
	}
}

func require(actor *authz.Actor, spec sideSpec, action string) error {
	if actor == nil || !actor.HasPermission(spec.prefix+":"+action) {
		return apierror.New(apierror.CodeForbidden, "无权限执行对账操作")
	}
	return nil
}

func requireCompany(actor *authz.Actor, id uuid.UUID, label string) error {
	if actor == nil || !actor.CanAccessCompany(id) {
		return apierror.New(apierror.CodeNotFound, label+"不存在")
	}
	return nil
}

func validatePage(query *ListQuery) error {
	if query.Limit == 0 {
		query.Limit = 20
	}
	if query.Limit < 1 || query.Limit > 200 || query.Offset < 0 {
		return apierror.Validation("分页参数不合法", map[string][]string{
			"limit": {"必须在 1 到 200 之间"}, "offset": {"不能小于 0"},
		})
	}
	return nil
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
	if input.CompanyID == uuid.Nil {
		return Head{}, apierror.Validation(spec.label+"参数不合法",
			map[string][]string{"companyId": {"必填"}})
	}
	if err := requireCompany(actor, input.CompanyID, spec.label); err != nil {
		return Head{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Head{}, apierror.Wrap(apierror.CodeInternal, "创建"+spec.label+"失败", err)
	}
	defer tx.Rollback(ctx)
	if err := fillDefaultAccounts(ctx, tx, spec, &input); err != nil {
		return Head{}, err
	}
	if err := validateHeadShape(spec, input); err != nil {
		return Head{}, err
	}
	if err := validateReferences(ctx, tx, spec, input.CompanyID, input.PartyType,
		input.PartyID, input.DebitAccountID, input.CreditAccountID); err != nil {
		return Head{}, err
	}
	no := ""
	if input.No != nil {
		no = strings.TrimSpace(*input.No)
	}
	if no == "" {
		no, err = s.numberer.NextInTx(ctx, tx, numbering.NextInput{
			Resource: spec.prefix,
			Values: map[string]any{
				"company_id": input.CompanyID, "posting_date": time.Now().UTC(),
			},
		})
		if err != nil {
			return Head{}, err
		}
	}
	id := uuid.New()
	_, err = tx.Exec(ctx, `INSERT INTO `+spec.table+`
		(id,reconciliation_no,reconciliation_type,party_type,party_id,remarks,
		 company_id,debit_account_id,credit_account_id,created_by_id)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
		id, no, input.Kind, strings.ToLower(strings.TrimSpace(input.PartyType)),
		input.PartyID, pgconv.OptionalText(input.Remarks), input.CompanyID, input.DebitAccountID,
		input.CreditAccountID, actorID(actor))
	if err != nil {
		return Head{}, writeError("创建"+spec.label+"失败", err)
	}
	result, err := queryHead(ctx, tx, spec, id, false)
	if err != nil {
		return Head{}, err
	}
	if err := audit.Write(ctx, tx, actor, audit.Entry{
		Resource: spec.table, RecordID: id, RecordLabel: no,
		ActionType: "create", ActionName: "create", CompanyID: &input.CompanyID,
		Changes: audit.Created(headSnapshot(result), headAuditFields),
	}); err != nil {
		return Head{}, apierror.Wrap(apierror.CodeInternal, "创建"+spec.label+"失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return Head{}, writeError("创建"+spec.label+"失败", err)
	}
	return result, nil
}

func fillDefaultAccounts(
	ctx context.Context, tx pgx.Tx, spec sideSpec, input *CreateHeadInput,
) error {
	if input.DebitAccountID != uuid.Nil && input.CreditAccountID != uuid.Nil {
		return nil
	}
	var debitID, creditID *uuid.UUID
	debitColumn, creditColumn := "delivery_credit_account_id", "delivery_debit_account_id"
	if spec.side == "purchase" {
		debitColumn, creditColumn = "receipt_credit_account_id", "receipt_debit_account_id"
	}
	err := tx.QueryRow(ctx, `SELECT `+debitColumn+`,`+creditColumn+
		` FROM sal_company_account_default WHERE company_id=$1`, input.CompanyID).
		Scan(&debitID, &creditID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "读取公司默认对账科目失败", err)
	}
	if input.DebitAccountID == uuid.Nil && debitID != nil {
		input.DebitAccountID = *debitID
	}
	if input.CreditAccountID == uuid.Nil && creditID != nil {
		input.CreditAccountID = *creditID
	}
	return nil
}

func validateHeadShape(spec sideSpec, input CreateHeadInput) error {
	fields := map[string][]string{}
	if input.CompanyID == uuid.Nil {
		fields["companyId"] = []string{"必填"}
	}
	if input.Kind != KindRegular && input.Kind != KindGiftSample {
		fields["reconciliationType"] = []string{"只允许 REGULAR 或 GIFT_SAMPLE"}
	}
	partyType := strings.ToLower(strings.TrimSpace(input.PartyType))
	if partyType != spec.party && partyType != "company" {
		fields["partyType"] = []string{"对手类型不合法"}
	}
	if input.PartyID == uuid.Nil {
		fields["partyId"] = []string{"必填"}
	}
	if partyType == "company" && input.PartyID == input.CompanyID {
		fields["partyId"] = []string{"对手不能是本公司"}
	}
	if input.DebitAccountID == uuid.Nil {
		fields["debitAccountId"] = []string{"必填"}
	}
	if input.CreditAccountID == uuid.Nil {
		fields["creditAccountId"] = []string{"必填"}
	}
	if input.No != nil && utf8.RuneCountInString(strings.TrimSpace(*input.No)) > 32 {
		fields["reconciliationNo"] = []string{"最多 32 个字符"}
	}
	if input.Remarks != nil && utf8.RuneCountInString(*input.Remarks) > 512 {
		fields["remarks"] = []string{"最多 512 个字符"}
	}
	if len(fields) > 0 {
		return apierror.Validation(spec.label+"参数不合法", fields)
	}
	return nil
}

func validateReferences(
	ctx context.Context, tx pgx.Tx, spec sideSpec, companyID uuid.UUID,
	partyType string, partyID, debitID, creditID uuid.UUID,
) error {
	var exists bool
	err := tx.QueryRow(ctx, `SELECT CASE $1::text
		WHEN 'customer' THEN EXISTS(SELECT 1 FROM sal_customers WHERE id=$2)
		WHEN 'supplier' THEN EXISTS(SELECT 1 FROM pur_supplier WHERE id=$2)
		WHEN 'company' THEN EXISTS(SELECT 1 FROM bas_company WHERE id=$2)
		ELSE false END`, strings.ToLower(strings.TrimSpace(partyType)), partyID).Scan(&exists)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "校验对账对手失败", err)
	}
	if !exists {
		return apierror.Validation(spec.label+"参数不合法",
			map[string][]string{"partyId": {"对手不存在"}})
	}
	type account struct {
		company uuid.UUID
		group   bool
		active  bool
		role    pgtype.Text
	}
	found := map[uuid.UUID]account{}
	rows, err := tx.Query(ctx, `SELECT id,company_id,is_group,active,role
		FROM bas_account WHERE id=ANY($1::uuid[])`, []uuid.UUID{debitID, creditID})
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "读取对账科目失败", err)
	}
	defer rows.Close()
	for rows.Next() {
		var id uuid.UUID
		var value account
		if err := rows.Scan(&id, &value.company, &value.group, &value.active, &value.role); err != nil {
			return apierror.Wrap(apierror.CodeInternal, "读取对账科目失败", err)
		}
		found[id] = value
	}
	for field, id := range map[string]uuid.UUID{
		"debitAccountId": debitID, "creditAccountId": creditID,
	} {
		value, ok := found[id]
		if !ok || value.company != companyID || value.group || !value.active {
			return apierror.Validation(spec.label+"参数不合法",
				map[string][]string{field: {"科目须属于本公司、启用且非汇总"}})
		}
		requiredRole := field == "creditAccountId" && spec.side == "sales" ||
			field == "debitAccountId" && spec.side == "purchase"
		wantRole := "unbilled_receivable"
		if spec.side == "purchase" {
			wantRole = "unbilled_payable"
		}
		if requiredRole && (!value.role.Valid || !strings.EqualFold(value.role.String, wantRole)) {
			return apierror.Validation(spec.label+"参数不合法",
				map[string][]string{field: {"科目角色不符合对账要求"}})
		}
	}
	return rows.Err()
}

func actorID(actor *authz.Actor) *uuid.UUID {
	if actor == nil || actor.UserID == uuid.Nil {
		return nil
	}
	return &actor.UserID
}

func date(value *time.Time) any {
	if value == nil {
		return nil
	}
	return value.UTC().Format(time.DateOnly)
}

var writeMappings = []dberr.Mapping{
	{Code: "23505", Message: "对账单号已存在", Bare: true},
}

func writeError(message string, err error) error {
	return dberr.MapWrite(err, message, writeMappings...)
}

var headAuditFields = []string{
	"reconciliation_no", "reconciliation_type", "party_type", "party_id",
	"posting_date", "remarks", "status", "company_id", "debit_account_id",
	"credit_account_id", "created_by_id",
}

var itemAuditFields = []string{
	"idx", "qty", "base_qty", "amount", "base_amount", "remarks",
	"reconciliation_id", "company_id", "delivery_item_id", "receipt_item_id",
	"outsourced_receipt_item_id",
}

func headSnapshot(item Head) map[string]any {
	return map[string]any{
		"reconciliation_no": item.No, "reconciliation_type": item.Kind,
		"party_type": item.PartyType, "party_id": item.PartyID,
		"posting_date": item.PostingDate, "remarks": item.Remarks, "status": item.Status,
		"company_id": item.CompanyID, "debit_account_id": item.DebitAccountID,
		"credit_account_id": item.CreditAccountID, "created_by_id": item.CreatedByID,
	}
}

func itemSnapshot(item Item) map[string]any {
	return map[string]any{
		"idx": item.Idx, "qty": item.Qty, "base_qty": item.BaseQty,
		"amount": item.Amount, "base_amount": item.BaseAmount, "remarks": item.Remarks,
		"reconciliation_id": item.ReconciliationID, "company_id": item.CompanyID,
		"delivery_item_id": item.DeliveryItemID, "receipt_item_id": item.ReceiptItemID,
		"outsourced_receipt_item_id": item.OutsourcedReceiptItemID,
	}
}

func scanHead(row pgx.Row) (Head, error) {
	var item Head
	var posting pgtype.Date
	err := row.Scan(
		&item.ID, &item.No, &item.Kind, &item.PartyType, &item.PartyID, &posting,
		&item.Remarks, &item.Status, &item.InsertedAt, &item.UpdatedAt,
		&item.CompanyID, &item.DebitAccountID, &item.CreditAccountID,
		&item.CreatedByID, &item.GrossTotal, &item.BaseGrossTotal,
	)
	if posting.Valid {
		value := posting.Time
		item.PostingDate = &value
	}
	return item, err
}

func queryHead(
	ctx context.Context, db interface {
		QueryRow(context.Context, string, ...any) pgx.Row
	}, spec sideSpec, id uuid.UUID, lock bool,
) (Head, error) {
	if lock {
		if err := db.QueryRow(ctx, `SELECT id FROM `+spec.table+` WHERE id=$1 FOR UPDATE`, id).
			Scan(&id); err != nil {
			return Head{}, err
		}
	}
	item, err := scanHead(db.QueryRow(ctx,
		headListSelect()+headListSource(spec)+` WHERE id=$1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return Head{}, apierror.New(apierror.CodeNotFound, spec.label+"不存在")
	}
	if err != nil {
		return Head{}, apierror.Wrap(apierror.CodeInternal, "读取"+spec.label+"失败", err)
	}
	return item, nil
}
