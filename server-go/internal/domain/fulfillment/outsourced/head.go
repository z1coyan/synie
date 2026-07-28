package outsourced

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/z1coyan/synie/server/internal/db/pgconv"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/audit"
	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/platform/numbering"
)

var issueAuditFields = []string{
	"issue_no", "issue_date", "party_type", "party_id", "remarks", "status",
	"audited_at", "company_id", "from_warehouse_id", "outsourced_warehouse_id",
	"created_by_id", "audited_by_id",
}

var receiptAuditFields = []string{
	"receipt_no", "receipt_date", "posting_date", "party_type", "party_id", "remarks",
	"status", "audited_at", "company_id", "warehouse_id", "outsourced_warehouse_id",
	"debit_account_id", "credit_account_id", "created_by_id", "audited_by_id",
}

func (s *Service) CreateIssue(ctx context.Context, actor *authz.Actor, input CreateIssueInput) (Issue, error) {
	if err := require(actor, issuePermissionPrefix, "create"); err != nil {
		return Issue{}, err
	}
	if actor == nil || !actor.CanAccessCompany(input.CompanyID) {
		return Issue{}, apierror.New(apierror.CodeForbidden, "无权在该公司创建委外发料单")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Issue{}, apierror.Wrap(apierror.CodeInternal, "创建委外发料单失败", err)
	}
	defer tx.Rollback(ctx)
	issueDate := todayUTC()
	if input.IssueDate != nil {
		issueDate = *input.IssueDate
	}
	no := ""
	if input.IssueNo != nil {
		no = strings.TrimSpace(*input.IssueNo)
	}
	if no == "" {
		no, err = s.numberer.NextInTx(ctx, tx, numbering.NextInput{
			Resource: "purchase.outsourced_issue",
			Values:   map[string]any{"company_id": input.CompanyID, "issue_date": issueDate},
		})
		if err != nil {
			return Issue{}, err
		}
	}
	var createdBy *uuid.UUID
	if actor.UserID != uuid.Nil {
		createdBy = &actor.UserID
	}
	item := Issue{
		IssueNo: no, IssueDate: issueDate,
		PartyType: strings.ToLower(strings.TrimSpace(input.PartyType)), PartyID: input.PartyID,
		Remarks: input.Remarks, Status: StatusDraft, CompanyID: input.CompanyID,
		FromWarehouseID: input.FromWarehouseID, OutsourcedWarehouseID: input.OutsourcedWarehouseID,
		CreatedByID: createdBy,
	}
	if err := validateIssue(ctx, tx, item); err != nil {
		return Issue{}, err
	}
	err = tx.QueryRow(ctx, `INSERT INTO pur_outsourced_issue(
		issue_no,issue_date,party_type,party_id,remarks,status,company_id,
		from_warehouse_id,outsourced_warehouse_id,created_by_id)
		VALUES($1,$2,$3,$4,$5,'draft',$6,$7,$8,$9) RETURNING id`,
		item.IssueNo, pgconv.Date(item.IssueDate), item.PartyType, item.PartyID, pgconv.Text(item.Remarks),
		item.CompanyID, item.FromWarehouseID, item.OutsourcedWarehouseID, item.CreatedByID,
	).Scan(&item.ID)
	if err != nil {
		return Issue{}, writeError("创建委外发料单", err)
	}
	result, err := queryIssue(ctx, tx, item.ID, false)
	if err != nil {
		return Issue{}, apierror.Wrap(apierror.CodeInternal, "读取新建委外发料单失败", err)
	}
	if err := writeAudit(ctx, tx, actor, issueTable, result.ID, result.IssueNo,
		"create", "create", result.CompanyID,
		audit.Created(issueSnapshot(result), issueAuditFields)); err != nil {
		return Issue{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Issue{}, writeError("创建委外发料单", err)
	}
	return result, nil
}

func (s *Service) UpdateIssue(ctx context.Context, actor *authz.Actor, id uuid.UUID, input UpdateIssueInput) (Issue, error) {
	if err := require(actor, issuePermissionPrefix, "update"); err != nil {
		return Issue{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Issue{}, apierror.Wrap(apierror.CodeInternal, "更新委外发料单失败", err)
	}
	defer tx.Rollback(ctx)
	before, err := lockDraftIssue(ctx, tx, actor, id)
	if err != nil {
		return Issue{}, err
	}
	after := before
	if input.IssueNo != nil {
		after.IssueNo = strings.TrimSpace(*input.IssueNo)
	}
	if input.IssueDate != nil {
		after.IssueDate = *input.IssueDate
	}
	if input.PartyType != nil {
		after.PartyType = strings.ToLower(strings.TrimSpace(*input.PartyType))
	}
	if input.PartyID != nil {
		after.PartyID = *input.PartyID
	}
	if input.Remarks.Set {
		after.Remarks = input.Remarks.Value
	}
	if input.FromWarehouseID.Set {
		after.FromWarehouseID = input.FromWarehouseID.Value
	}
	if input.OutsourcedWarehouseID.Set {
		after.OutsourcedWarehouseID = input.OutsourcedWarehouseID.Value
	}
	if err := freezeIssueIdentity(ctx, tx, before, after); err != nil {
		return Issue{}, err
	}
	if err := validateIssue(ctx, tx, after); err != nil {
		return Issue{}, err
	}
	changes := audit.Diff(issueSnapshot(before), issueSnapshot(after), issueAuditFields)
	if len(changes) == 0 {
		if err := tx.Commit(ctx); err != nil {
			return Issue{}, writeError("更新委外发料单", err)
		}
		return before, nil
	}
	_, err = tx.Exec(ctx, `UPDATE pur_outsourced_issue SET issue_no=$2,issue_date=$3,
		party_type=$4,party_id=$5,remarks=$6,from_warehouse_id=$7,
		outsourced_warehouse_id=$8,updated_at=(now() AT TIME ZONE 'utc') WHERE id=$1`,
		id, after.IssueNo, pgconv.Date(after.IssueDate), after.PartyType, after.PartyID,
		pgconv.Text(after.Remarks), after.FromWarehouseID, after.OutsourcedWarehouseID)
	if err != nil {
		return Issue{}, writeError("更新委外发料单", err)
	}
	result, err := queryIssue(ctx, tx, id, false)
	if err != nil {
		return Issue{}, apierror.Wrap(apierror.CodeInternal, "读取更新后委外发料单失败", err)
	}
	if err := writeAudit(ctx, tx, actor, issueTable, id, result.IssueNo,
		"update", "update", result.CompanyID, changes); err != nil {
		return Issue{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Issue{}, writeError("更新委外发料单", err)
	}
	return result, nil
}

func (s *Service) DeleteIssue(ctx context.Context, actor *authz.Actor, id uuid.UUID) error {
	if err := require(actor, issuePermissionPrefix, "delete"); err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除委外发料单失败", err)
	}
	defer tx.Rollback(ctx)
	item, err := lockDraftIssue(ctx, tx, actor, id)
	if err != nil {
		return err
	}
	if err := writeAudit(ctx, tx, actor, issueTable, id, item.IssueNo, "destroy", "destroy",
		item.CompanyID, audit.Destroyed(issueSnapshot(item), issueAuditFields)); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM pur_outsourced_issue WHERE id=$1`, id); err != nil {
		return writeError("删除委外发料单", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return writeError("删除委外发料单", err)
	}
	return nil
}

func (s *Service) CreateReceipt(ctx context.Context, actor *authz.Actor, input CreateReceiptInput) (Receipt, error) {
	if err := require(actor, receiptPermissionPrefix, "create"); err != nil {
		return Receipt{}, err
	}
	if actor == nil || !actor.CanAccessCompany(input.CompanyID) {
		return Receipt{}, apierror.New(apierror.CodeForbidden, "无权在该公司创建委外入库单")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Receipt{}, apierror.Wrap(apierror.CodeInternal, "创建委外入库单失败", err)
	}
	defer tx.Rollback(ctx)
	receiptDate := todayUTC()
	if input.ReceiptDate != nil {
		receiptDate = *input.ReceiptDate
	}
	no := ""
	if input.ReceiptNo != nil {
		no = strings.TrimSpace(*input.ReceiptNo)
	}
	if no == "" {
		no, err = s.numberer.NextInTx(ctx, tx, numbering.NextInput{
			Resource: "purchase.outsourced_receipt",
			Values:   map[string]any{"company_id": input.CompanyID, "receipt_date": receiptDate},
		})
		if err != nil {
			return Receipt{}, err
		}
	}
	debit, credit, err := receiptAccounts(ctx, tx, input.CompanyID, input.DebitAccountID, input.CreditAccountID)
	if err != nil {
		return Receipt{}, err
	}
	var createdBy *uuid.UUID
	if actor.UserID != uuid.Nil {
		createdBy = &actor.UserID
	}
	item := Receipt{
		ReceiptNo: no, ReceiptDate: receiptDate, PostingDate: input.PostingDate,
		PartyType: strings.ToLower(strings.TrimSpace(input.PartyType)), PartyID: input.PartyID,
		Remarks: input.Remarks, Status: StatusDraft, CompanyID: input.CompanyID,
		WarehouseID: input.WarehouseID, OutsourcedWarehouseID: input.OutsourcedWarehouseID,
		DebitAccountID: debit, CreditAccountID: credit, CreatedByID: createdBy,
	}
	if err := validateReceipt(ctx, tx, item); err != nil {
		return Receipt{}, err
	}
	err = tx.QueryRow(ctx, `INSERT INTO pur_outsourced_receipt(
		receipt_no,receipt_date,posting_date,party_type,party_id,remarks,status,
		company_id,warehouse_id,outsourced_warehouse_id,debit_account_id,
		credit_account_id,created_by_id)
		VALUES($1,$2,$3,$4,$5,$6,'draft',$7,$8,$9,$10,$11,$12) RETURNING id`,
		item.ReceiptNo, pgconv.Date(item.ReceiptDate), nullableDate(item.PostingDate), item.PartyType,
		item.PartyID, pgconv.Text(item.Remarks), item.CompanyID, item.WarehouseID,
		item.OutsourcedWarehouseID, item.DebitAccountID, item.CreditAccountID,
		item.CreatedByID).Scan(&item.ID)
	if err != nil {
		return Receipt{}, writeError("创建委外入库单", err)
	}
	result, err := queryReceipt(ctx, tx, item.ID, false)
	if err != nil {
		return Receipt{}, apierror.Wrap(apierror.CodeInternal, "读取新建委外入库单失败", err)
	}
	if err := writeAudit(ctx, tx, actor, receiptTable, result.ID, result.ReceiptNo,
		"create", "create", result.CompanyID,
		audit.Created(receiptSnapshot(result), receiptAuditFields)); err != nil {
		return Receipt{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Receipt{}, writeError("创建委外入库单", err)
	}
	return result, nil
}

func (s *Service) UpdateReceipt(ctx context.Context, actor *authz.Actor, id uuid.UUID, input UpdateReceiptInput) (Receipt, error) {
	if err := require(actor, receiptPermissionPrefix, "update"); err != nil {
		return Receipt{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Receipt{}, apierror.Wrap(apierror.CodeInternal, "更新委外入库单失败", err)
	}
	defer tx.Rollback(ctx)
	before, err := lockDraftReceipt(ctx, tx, actor, id)
	if err != nil {
		return Receipt{}, err
	}
	after := before
	if input.ReceiptNo != nil {
		after.ReceiptNo = strings.TrimSpace(*input.ReceiptNo)
	}
	if input.ReceiptDate != nil {
		after.ReceiptDate = *input.ReceiptDate
	}
	if input.PostingDate.Set {
		after.PostingDate = input.PostingDate.Value
	}
	if input.PartyType != nil {
		after.PartyType = strings.ToLower(strings.TrimSpace(*input.PartyType))
	}
	if input.PartyID != nil {
		after.PartyID = *input.PartyID
	}
	if input.Remarks.Set {
		after.Remarks = input.Remarks.Value
	}
	if input.WarehouseID.Set {
		after.WarehouseID = input.WarehouseID.Value
	}
	if input.OutsourcedWarehouseID.Set {
		after.OutsourcedWarehouseID = input.OutsourcedWarehouseID.Value
	}
	if input.DebitAccountID != nil {
		after.DebitAccountID = *input.DebitAccountID
	}
	if input.CreditAccountID != nil {
		after.CreditAccountID = *input.CreditAccountID
	}
	if err := freezeReceiptIdentity(ctx, tx, before, after); err != nil {
		return Receipt{}, err
	}
	if err := validateReceipt(ctx, tx, after); err != nil {
		return Receipt{}, err
	}
	changes := audit.Diff(receiptSnapshot(before), receiptSnapshot(after), receiptAuditFields)
	if len(changes) == 0 {
		if err := tx.Commit(ctx); err != nil {
			return Receipt{}, writeError("更新委外入库单", err)
		}
		return before, nil
	}
	_, err = tx.Exec(ctx, `UPDATE pur_outsourced_receipt SET receipt_no=$2,
		receipt_date=$3,posting_date=$4,party_type=$5,party_id=$6,remarks=$7,
		warehouse_id=$8,outsourced_warehouse_id=$9,debit_account_id=$10,
		credit_account_id=$11,updated_at=(now() AT TIME ZONE 'utc') WHERE id=$1`,
		id, after.ReceiptNo, pgconv.Date(after.ReceiptDate), nullableDate(after.PostingDate),
		after.PartyType, after.PartyID, pgconv.Text(after.Remarks), after.WarehouseID,
		after.OutsourcedWarehouseID, after.DebitAccountID, after.CreditAccountID)
	if err != nil {
		return Receipt{}, writeError("更新委外入库单", err)
	}
	result, err := queryReceipt(ctx, tx, id, false)
	if err != nil {
		return Receipt{}, apierror.Wrap(apierror.CodeInternal, "读取更新后委外入库单失败", err)
	}
	if err := writeAudit(ctx, tx, actor, receiptTable, id, result.ReceiptNo,
		"update", "update", result.CompanyID, changes); err != nil {
		return Receipt{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Receipt{}, writeError("更新委外入库单", err)
	}
	return result, nil
}

func (s *Service) DeleteReceipt(ctx context.Context, actor *authz.Actor, id uuid.UUID) error {
	if err := require(actor, receiptPermissionPrefix, "delete"); err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除委外入库单失败", err)
	}
	defer tx.Rollback(ctx)
	item, err := lockDraftReceipt(ctx, tx, actor, id)
	if err != nil {
		return err
	}
	if err := writeAudit(ctx, tx, actor, receiptTable, id, item.ReceiptNo,
		"destroy", "destroy", item.CompanyID,
		audit.Destroyed(receiptSnapshot(item), receiptAuditFields)); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM pur_outsourced_receipt WHERE id=$1`, id); err != nil {
		return writeError("删除委外入库单", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return writeError("删除委外入库单", err)
	}
	return nil
}

func validateIssue(ctx context.Context, tx pgx.Tx, item Issue) error {
	if err := validateCommonHead(item.CompanyID, item.IssueNo, item.IssueDate, item.PartyType, item.PartyID, item.Remarks); err != nil {
		return err
	}
	if err := validateParty(ctx, tx, item.PartyType, item.PartyID); err != nil {
		return err
	}
	if item.FromWarehouseID != nil {
		if err := validateWarehouse(ctx, tx, item.CompanyID, *item.FromWarehouseID); err != nil {
			return err
		}
	}
	if item.OutsourcedWarehouseID != nil {
		if err := validateOutsourcedWarehouse(ctx, tx, item.CompanyID, item.PartyType, item.PartyID, *item.OutsourcedWarehouseID); err != nil {
			return err
		}
	}
	return nil
}

func validateReceipt(ctx context.Context, tx pgx.Tx, item Receipt) error {
	if err := validateCommonHead(item.CompanyID, item.ReceiptNo, item.ReceiptDate, item.PartyType, item.PartyID, item.Remarks); err != nil {
		return err
	}
	if item.DebitAccountID == uuid.Nil || item.CreditAccountID == uuid.Nil {
		return apierror.Validation("委外入库单参数不合法", map[string][]string{
			"debitAccountId": {"必填"}, "creditAccountId": {"必填"},
		})
	}
	if err := validateParty(ctx, tx, item.PartyType, item.PartyID); err != nil {
		return err
	}
	if item.WarehouseID != nil {
		if err := validateWarehouse(ctx, tx, item.CompanyID, *item.WarehouseID); err != nil {
			return err
		}
	}
	if item.OutsourcedWarehouseID != nil {
		if err := validateOutsourcedWarehouse(ctx, tx, item.CompanyID, item.PartyType, item.PartyID, *item.OutsourcedWarehouseID); err != nil {
			return err
		}
	}
	return validateReceiptAccounts(ctx, tx, item)
}

func validateReceiptAccounts(ctx context.Context, tx pgx.Tx, item Receipt) error {
	type account struct {
		companyID uuid.UUID
		group     bool
		active    bool
		role      pgtype.Text
	}
	accounts := map[uuid.UUID]account{}
	rows, err := tx.Query(ctx, `SELECT id,company_id,is_group,active,role FROM bas_account
		WHERE id=ANY($1::uuid[])`, []uuid.UUID{item.DebitAccountID, item.CreditAccountID})
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "读取委外入库科目失败", err)
	}
	for rows.Next() {
		var id uuid.UUID
		var value account
		if err := rows.Scan(&id, &value.companyID, &value.group, &value.active, &value.role); err != nil {
			rows.Close()
			return apierror.Wrap(apierror.CodeInternal, "读取委外入库科目失败", err)
		}
		accounts[id] = value
	}
	rows.Close()
	for field, id := range map[string]uuid.UUID{"debitAccountId": item.DebitAccountID, "creditAccountId": item.CreditAccountID} {
		value, ok := accounts[id]
		if !ok || value.companyID != item.CompanyID || value.group || !value.active {
			return apierror.Validation("委外入库科目不合法", map[string][]string{field: {"须属于单据公司、启用且非汇总"}})
		}
		if field == "creditAccountId" && (!value.role.Valid || !strings.EqualFold(value.role.String, "unbilled_payable")) {
			return apierror.Validation("委外入库科目不合法", map[string][]string{field: {"须为未开票应付角色科目"}})
		}
	}
	return nil
}

func receiptAccounts(ctx context.Context, tx pgx.Tx, companyID uuid.UUID, debit, credit *uuid.UUID) (uuid.UUID, uuid.UUID, error) {
	var defaultsDebit, defaultsCredit *uuid.UUID
	if debit == nil || credit == nil {
		err := tx.QueryRow(ctx, `SELECT receipt_debit_account_id,receipt_credit_account_id
			FROM sal_company_account_default WHERE company_id=$1`, companyID).
			Scan(&defaultsDebit, &defaultsCredit)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return uuid.Nil, uuid.Nil, apierror.Wrap(apierror.CodeInternal, "读取公司默认入库科目失败", err)
		}
	}
	if debit == nil {
		debit = defaultsDebit
	}
	if credit == nil {
		credit = defaultsCredit
	}
	if debit == nil || credit == nil {
		return uuid.Nil, uuid.Nil, apierror.Validation("委外入库单参数不合法", map[string][]string{
			"accounts": {"未填写科目且公司未配置默认入库科目"},
		})
	}
	return *debit, *credit, nil
}

func freezeIssueIdentity(ctx context.Context, tx pgx.Tx, before, after Issue) error {
	if before.PartyType == after.PartyType && before.PartyID == after.PartyID {
		return nil
	}
	var exists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pur_outsourced_issue_item WHERE issue_id=$1)`, before.ID).Scan(&exists); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "检查委外发料行失败", err)
	}
	if exists {
		return apierror.New(apierror.CodeConflict, "已有发料行时不可修改公司或对手")
	}
	return nil
}

func freezeReceiptIdentity(ctx context.Context, tx pgx.Tx, before, after Receipt) error {
	if before.PartyType == after.PartyType && before.PartyID == after.PartyID {
		return nil
	}
	var exists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pur_outsourced_receipt_item WHERE receipt_id=$1)`, before.ID).Scan(&exists); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "检查委外入库行失败", err)
	}
	if exists {
		return apierror.New(apierror.CodeConflict, "已有成品行时不可修改公司或对手")
	}
	return nil
}

func lockIssue(ctx context.Context, tx pgx.Tx, actor *authz.Actor, id uuid.UUID) (Issue, error) {
	item, err := queryIssue(ctx, tx, id, true)
	if errors.Is(err, pgx.ErrNoRows) {
		return Issue{}, apierror.New(apierror.CodeNotFound, "委外发料单不存在")
	}
	if err != nil {
		return Issue{}, apierror.Wrap(apierror.CodeInternal, "锁定委外发料单失败", err)
	}
	if err := requireCompany(actor, item.CompanyID, "委外发料单不存在"); err != nil {
		return Issue{}, err
	}
	return item, nil
}

func lockDraftIssue(ctx context.Context, tx pgx.Tx, actor *authz.Actor, id uuid.UUID) (Issue, error) {
	item, err := lockIssue(ctx, tx, actor, id)
	if err != nil {
		return Issue{}, err
	}
	if item.Status != StatusDraft {
		return Issue{}, apierror.New(apierror.CodeConflict, "仅草稿委外发料单可编辑")
	}
	return item, nil
}

func lockReceipt(ctx context.Context, tx pgx.Tx, actor *authz.Actor, id uuid.UUID) (Receipt, error) {
	item, err := queryReceipt(ctx, tx, id, true)
	if errors.Is(err, pgx.ErrNoRows) {
		return Receipt{}, apierror.New(apierror.CodeNotFound, "委外入库单不存在")
	}
	if err != nil {
		return Receipt{}, apierror.Wrap(apierror.CodeInternal, "锁定委外入库单失败", err)
	}
	if err := requireCompany(actor, item.CompanyID, "委外入库单不存在"); err != nil {
		return Receipt{}, err
	}
	return item, nil
}

func lockDraftReceipt(ctx context.Context, tx pgx.Tx, actor *authz.Actor, id uuid.UUID) (Receipt, error) {
	item, err := lockReceipt(ctx, tx, actor, id)
	if err != nil {
		return Receipt{}, err
	}
	if item.Status != StatusDraft {
		return Receipt{}, apierror.New(apierror.CodeConflict, "仅草稿委外入库单可编辑")
	}
	return item, nil
}

func nullableDate(value *time.Time) pgtype.Date {
	if value == nil {
		return pgtype.Date{}
	}
	return pgconv.Date(*value)
}

func issueSnapshot(item Issue) map[string]any {
	return map[string]any{
		"issue_no": item.IssueNo, "issue_date": item.IssueDate, "party_type": item.PartyType,
		"party_id": item.PartyID, "remarks": item.Remarks, "status": item.Status,
		"audited_at": item.AuditedAt, "company_id": item.CompanyID,
		"from_warehouse_id":       item.FromWarehouseID,
		"outsourced_warehouse_id": item.OutsourcedWarehouseID,
		"created_by_id":           item.CreatedByID, "audited_by_id": item.AuditedByID,
	}
}

func receiptSnapshot(item Receipt) map[string]any {
	return map[string]any{
		"receipt_no": item.ReceiptNo, "receipt_date": item.ReceiptDate,
		"posting_date": item.PostingDate, "party_type": item.PartyType,
		"party_id": item.PartyID, "remarks": item.Remarks, "status": item.Status,
		"audited_at": item.AuditedAt, "company_id": item.CompanyID,
		"warehouse_id":            item.WarehouseID,
		"outsourced_warehouse_id": item.OutsourcedWarehouseID,
		"debit_account_id":        item.DebitAccountID, "credit_account_id": item.CreditAccountID,
		"created_by_id": item.CreatedByID, "audited_by_id": item.AuditedByID,
	}
}
