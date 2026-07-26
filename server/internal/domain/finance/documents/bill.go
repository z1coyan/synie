package documents

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
	"github.com/z1coyan/synie/server/internal/engines/gl"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/platform/numbering"
)

const (
	billColumns = `id,bill_no,bill_kind,issue_date,due_date,face_amount,
		drawer_name,drawer_account,drawer_bank_name,drawer_bank_no,payee_name,
		payee_account,payee_bank_name,payee_bank_no,acceptor_name,acceptor_account,
		acceptor_bank_name,acceptor_bank_no,transferable,acceptance_date,remarks,
		inserted_at,updated_at`
	billTransactionColumns = `id,doc_no,transaction_type,occurred_on,sub_start,
		sub_end,amount,party_type,party_id,discount_org,discount_rate,interest,
		net_amount,posting_date,status,audited_at,remarks,inserted_at,updated_at,
		company_id,bank_account_id,to_bank_account_id,bill_id,bill_account_id,
		settle_account_id,interest_account_id,created_by_id,audited_by_id`
	billHoldingColumns = `id,bill_no,sub_start,sub_end,amount,due_date,acquired_on,
		inserted_at,company_id,bank_account_id,bill_id,source_transaction_id`
)

func (s *Service) QueryBills(
	ctx context.Context, actor *authz.Actor, query ListQuery,
) (BillList, error) {
	if err := requirePermission(actor, "acc.bill:read"); err != nil {
		return BillList{}, err
	}
	if err := validateList(&query); err != nil {
		return BillList{}, err
	}
	built, err := filterbuild.Build(BillResourceMeta(), filterbuild.Query{
		Limit: query.Limit, Offset: query.Offset, Search: query.Search,
		Sort: query.Sort, Filter: query.Filter,
	})
	if err != nil {
		return BillList{}, err
	}
	built.Where, built.Args = billScope(actor, built.Where, built.Args, "acc_bill.id")
	var result BillList
	if err = s.pool.QueryRow(ctx, `SELECT count(*) FROM acc_bill`+
		built.Where, built.Args...).Scan(&result.Count); err != nil {
		return result, apierror.Wrap(apierror.CodeInternal, "统计承兑票据失败", err)
	}
	sql, args := appendPagination(`SELECT `+billColumns+` FROM acc_bill`+
		built.Where+built.OrderBy, built.Args, query)
	rows, err := s.pool.Query(ctx, sql, args...)
	if err != nil {
		return result, apierror.Wrap(apierror.CodeInternal, "查询承兑票据失败", err)
	}
	defer rows.Close()
	result.Results = make([]Bill, 0, query.Limit)
	for rows.Next() {
		item, scanErr := scanBill(rows)
		if scanErr != nil {
			return result, apierror.Wrap(apierror.CodeInternal, "读取承兑票据失败", scanErr)
		}
		result.Results = append(result.Results, item)
	}
	return result, rows.Err()
}

func (s *Service) GetBill(
	ctx context.Context, actor *authz.Actor, id uuid.UUID,
) (Bill, error) {
	if err := requirePermission(actor, "acc.bill:read"); err != nil {
		return Bill{}, err
	}
	where, args := billScope(actor, " WHERE id=$1", []any{id}, "acc_bill.id")
	item, err := scanBill(s.pool.QueryRow(ctx,
		`SELECT `+billColumns+` FROM acc_bill`+where, args...))
	if err != nil {
		return Bill{}, notFound("承兑票据", err)
	}
	return item, nil
}

func (s *Service) UpdateBill(
	ctx context.Context, actor *authz.Actor, id uuid.UUID, input BillUpdateInput,
) (Bill, error) {
	if err := requirePermission(actor, "acc.bill:update"); err != nil {
		return Bill{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Bill{}, apierror.Wrap(apierror.CodeInternal, "更新承兑票据失败", err)
	}
	defer tx.Rollback(ctx)
	before, err := lockBillForActor(ctx, tx, id, actor)
	if err != nil {
		return Bill{}, err
	}
	attrs := billToAttrs(before)
	overlayBillAttrs(&attrs, input)
	if err = validateBillAttrs(attrs); err != nil {
		return Bill{}, err
	}
	var hasTransactions bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM acc_bill_transaction
		WHERE bill_id=$1)`, id).Scan(&hasTransactions); err != nil {
		return Bill{}, apierror.Wrap(apierror.CodeInternal, "检查票据交易失败", err)
	}
	if hasTransactions && (attrs.DueDate != before.DueDate ||
		!optionalDecimalEqual(attrs.FaceAmount, before.FaceAmount) ||
		(attrs.Transferable != nil && *attrs.Transferable != before.Transferable)) {
		return Bill{}, apierror.New(apierror.CodeConflict,
			"票据已有交易,到期日、票面金额与能否转让不可修改")
	}
	args, err := billArgs(attrs)
	if err != nil {
		return Bill{}, err
	}
	_, err = tx.Exec(ctx, `UPDATE acc_bill SET bill_kind=$2,issue_date=$3,due_date=$4,
		face_amount=$5,drawer_name=$6,drawer_account=$7,drawer_bank_name=$8,
		drawer_bank_no=$9,payee_name=$10,payee_account=$11,payee_bank_name=$12,
		payee_bank_no=$13,acceptor_name=$14,acceptor_account=$15,
		acceptor_bank_name=$16,acceptor_bank_no=$17,transferable=$18,
		acceptance_date=$19,remarks=$20,updated_at=(now() AT TIME ZONE 'utc')
		WHERE id=$1`, append([]any{id}, args[1:]...)...)
	if err != nil {
		return Bill{}, databaseWriteError("更新承兑票据失败", err)
	}
	result, err := queryBill(ctx, tx, id, false)
	if err != nil {
		return Bill{}, err
	}
	if err = writeAudit(ctx, tx, actor, "acc_bill", id, result.BillNo,
		"update", "update", nil,
		changedValues(billSnapshot(before), billSnapshot(result))); err != nil {
		return Bill{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Bill{}, databaseWriteError("更新承兑票据失败", err)
	}
	return result, nil
}

func (s *Service) DeleteBill(
	ctx context.Context, actor *authz.Actor, id uuid.UUID,
) error {
	if err := requirePermission(actor, "acc.bill:delete"); err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除承兑票据失败", err)
	}
	defer tx.Rollback(ctx)
	before, err := lockBillForActor(ctx, tx, id, actor)
	if err != nil {
		return err
	}
	var exists bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM acc_bill_transaction
		WHERE bill_id=$1)`, id).Scan(&exists); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "检查票据交易失败", err)
	}
	if exists {
		return apierror.New(apierror.CodeConflict, "票据已有交易,不可删除")
	}
	if _, err = tx.Exec(ctx, `DELETE FROM acc_bill WHERE id=$1`, id); err != nil {
		return databaseWriteError("删除承兑票据失败", err)
	}
	if err = writeAudit(ctx, tx, actor, "acc_bill", id, before.BillNo,
		"delete", "delete", nil, changedValues(billSnapshot(before), map[string]any{})); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return databaseWriteError("删除承兑票据失败", err)
	}
	return nil
}

func (s *Service) QueryBillTransactions(
	ctx context.Context, actor *authz.Actor, query ListQuery,
) (BillTransactionList, error) {
	if err := requirePermission(actor, "acc.bill_transaction:read"); err != nil {
		return BillTransactionList{}, err
	}
	if err := validateList(&query); err != nil {
		return BillTransactionList{}, err
	}
	built, err := filterbuild.Build(BillTransactionResourceMeta(), filterbuild.Query{
		Limit: query.Limit, Offset: query.Offset, Search: query.Search,
		Sort: query.Sort, Filter: query.Filter,
	})
	if err != nil {
		return BillTransactionList{}, err
	}
	built.Where, built.Args = companyScope(actor, built.Where, built.Args, "company_id")
	var result BillTransactionList
	if err = s.pool.QueryRow(ctx, `SELECT count(*) FROM acc_bill_transaction`+
		built.Where, built.Args...).Scan(&result.Count); err != nil {
		return result, apierror.Wrap(apierror.CodeInternal, "统计承兑交易失败", err)
	}
	sql, args := appendPagination(`SELECT `+billTransactionColumns+
		` FROM acc_bill_transaction`+built.Where+built.OrderBy, built.Args, query)
	rows, err := s.pool.Query(ctx, sql, args...)
	if err != nil {
		return result, apierror.Wrap(apierror.CodeInternal, "查询承兑交易失败", err)
	}
	defer rows.Close()
	result.Results = make([]BillTransaction, 0, query.Limit)
	for rows.Next() {
		item, scanErr := scanBillTransaction(rows)
		if scanErr != nil {
			return result, apierror.Wrap(apierror.CodeInternal, "读取承兑交易失败", scanErr)
		}
		result.Results = append(result.Results, item)
	}
	return result, rows.Err()
}

func (s *Service) GetBillTransaction(
	ctx context.Context, actor *authz.Actor, id uuid.UUID,
) (BillTransaction, error) {
	if err := requirePermission(actor, "acc.bill_transaction:read"); err != nil {
		return BillTransaction{}, err
	}
	where, args := companyScope(actor, " WHERE id=$1", []any{id}, "company_id")
	item, err := scanBillTransaction(s.pool.QueryRow(ctx,
		`SELECT `+billTransactionColumns+` FROM acc_bill_transaction`+where, args...))
	if err != nil {
		return BillTransaction{}, notFound("承兑交易", err)
	}
	return item, nil
}

func (s *Service) CreateBillTransaction(
	ctx context.Context, actor *authz.Actor, input BillTransactionInput,
) (BillTransaction, error) {
	if err := requirePermission(actor, "acc.bill_transaction:create"); err != nil {
		return BillTransaction{}, err
	}
	if err := requireCompany(actor, input.CompanyID, "承兑交易"); err != nil {
		return BillTransaction{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return BillTransaction{}, apierror.Wrap(apierror.CodeInternal, "创建承兑交易失败", err)
	}
	defer tx.Rollback(ctx)
	input.TransactionType = upper(input.TransactionType)
	if input.TransactionType == TransactionReceive {
		if (input.BillID == nil) == (input.BillAttrs == nil) {
			return BillTransaction{}, apierror.Validation("承兑交易参数不合法",
				map[string][]string{"bill": {"接收交易须且仅须传 billId 或 billAttrs"}})
		}
		if input.BillID == nil {
			bill, registerErr := registerBill(ctx, tx, *input.BillAttrs)
			if registerErr != nil {
				return BillTransaction{}, registerErr
			}
			input.BillID = &bill.ID
		}
	} else if input.BillID == nil || input.BillAttrs != nil {
		return BillTransaction{}, apierror.Validation("承兑交易参数不合法",
			map[string][]string{"billId": {"非接收交易必须填写 billId"}})
	}
	bill, err := queryBill(ctx, tx, *input.BillID, true)
	if err != nil {
		return BillTransaction{}, err
	}
	normalized, values, err := validateTransaction(ctx, tx, input, bill, true)
	if err != nil {
		return BillTransaction{}, err
	}
	docNo := ""
	if input.DocNo != nil {
		docNo = strings.TrimSpace(*input.DocNo)
	}
	if docNo == "" {
		docNo, err = s.numberer.NextInTx(ctx, tx, numbering.NextInput{
			Resource: "acc.bill_transaction",
			Values:   map[string]any{"company_id": input.CompanyID, "posting_date": values.occurredOn},
		})
		if err != nil {
			return BillTransaction{}, err
		}
	}
	id := uuid.New()
	_, err = tx.Exec(ctx, `INSERT INTO acc_bill_transaction(
		id,doc_no,transaction_type,occurred_on,sub_start,sub_end,amount,party_type,
		party_id,discount_org,discount_rate,interest,net_amount,posting_date,remarks,
		company_id,bank_account_id,to_bank_account_id,bill_id,bill_account_id,
		settle_account_id,interest_account_id,created_by_id)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
		$18,$19,$20,$21,$22,$23)`, id, docNo, lower(normalized.TransactionType),
		values.occurredOn, normalized.SubStart, normalized.SubEnd, values.amount,
		lowerOptional(normalized.PartyType), normalized.PartyID, normalized.DiscountOrg,
		values.discountRate, values.interest, values.netAmount, values.postingDate,
		normalized.Remarks, normalized.CompanyID, normalized.BankAccountID,
		normalized.ToBankAccountID, normalized.BillID, normalized.BillAccountID,
		normalized.SettleAccountID, normalized.InterestAccountID, actorID(actor))
	if err != nil {
		return BillTransaction{}, databaseWriteError("创建承兑交易失败", err)
	}
	result, err := queryBillTransaction(ctx, tx, id, false)
	if err != nil {
		return BillTransaction{}, err
	}
	if err = writeAudit(ctx, tx, actor, "acc_bill_transaction", id, docNo,
		"create", "create", &result.CompanyID,
		createdChanges(billTransactionSnapshot(result))); err != nil {
		return BillTransaction{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return BillTransaction{}, databaseWriteError("创建承兑交易失败", err)
	}
	return result, nil
}

func (s *Service) UpdateBillTransaction(
	ctx context.Context, actor *authz.Actor, id uuid.UUID, input BillTransactionUpdateInput,
) (BillTransaction, error) {
	if err := requirePermission(actor, "acc.bill_transaction:update"); err != nil {
		return BillTransaction{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return BillTransaction{}, apierror.Wrap(apierror.CodeInternal, "更新承兑交易失败", err)
	}
	defer tx.Rollback(ctx)
	before, err := lockBillTransaction(ctx, tx, id, actor)
	if err != nil {
		return BillTransaction{}, err
	}
	if before.Status != StatusDraft {
		return BillTransaction{}, apierror.New(apierror.CodeConflict, "仅草稿承兑交易可修改或删除")
	}
	merged := transactionToInput(before)
	overlayTransaction(&merged, input)
	bill, err := queryBill(ctx, tx, *merged.BillID, true)
	if err != nil {
		return BillTransaction{}, err
	}
	requireActive := merged.BankAccountID != before.BankAccountID ||
		!uuidPointerEqual(merged.ToBankAccountID, before.ToBankAccountID)
	normalized, values, err := validateTransaction(ctx, tx, merged, bill, requireActive)
	if err != nil {
		return BillTransaction{}, err
	}
	_, err = tx.Exec(ctx, `UPDATE acc_bill_transaction SET doc_no=$2,occurred_on=$3,
		sub_start=$4,sub_end=$5,amount=$6,party_type=$7,party_id=$8,discount_org=$9,
		discount_rate=$10,interest=$11,net_amount=$12,posting_date=$13,remarks=$14,
		bank_account_id=$15,to_bank_account_id=$16,bill_id=$17,bill_account_id=$18,
		settle_account_id=$19,interest_account_id=$20,
		updated_at=(now() AT TIME ZONE 'utc') WHERE id=$1`, id, normalized.DocNo,
		values.occurredOn, normalized.SubStart, normalized.SubEnd, values.amount,
		lowerOptional(normalized.PartyType), normalized.PartyID, normalized.DiscountOrg,
		values.discountRate, values.interest, values.netAmount, values.postingDate,
		normalized.Remarks, normalized.BankAccountID, normalized.ToBankAccountID,
		normalized.BillID, normalized.BillAccountID, normalized.SettleAccountID,
		normalized.InterestAccountID)
	if err != nil {
		return BillTransaction{}, databaseWriteError("更新承兑交易失败", err)
	}
	result, err := queryBillTransaction(ctx, tx, id, false)
	if err != nil {
		return BillTransaction{}, err
	}
	if err = writeAudit(ctx, tx, actor, "acc_bill_transaction", id, transactionLabel(result),
		"update", "update", &result.CompanyID,
		changedValues(billTransactionSnapshot(before), billTransactionSnapshot(result))); err != nil {
		return BillTransaction{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return BillTransaction{}, databaseWriteError("更新承兑交易失败", err)
	}
	return result, nil
}

func (s *Service) DeleteBillTransaction(
	ctx context.Context, actor *authz.Actor, id uuid.UUID,
) error {
	if err := requirePermission(actor, "acc.bill_transaction:delete"); err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除承兑交易失败", err)
	}
	defer tx.Rollback(ctx)
	before, err := lockBillTransaction(ctx, tx, id, actor)
	if err != nil {
		return err
	}
	if before.Status != StatusDraft {
		return apierror.New(apierror.CodeConflict, "仅草稿承兑交易可修改或删除")
	}
	if _, err = tx.Exec(ctx, `DELETE FROM acc_bill_transaction WHERE id=$1`, id); err != nil {
		return databaseWriteError("删除承兑交易失败", err)
	}
	if err = writeAudit(ctx, tx, actor, "acc_bill_transaction", id, transactionLabel(before),
		"delete", "delete", &before.CompanyID,
		changedValues(billTransactionSnapshot(before), map[string]any{})); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return databaseWriteError("删除承兑交易失败", err)
	}
	return nil
}

func (s *Service) AuditBillTransaction(
	ctx context.Context, actor *authz.Actor, id uuid.UUID, input AuditBillTransactionInput,
) (BillTransaction, error) {
	if err := requirePermission(actor, "acc.bill_transaction:audit"); err != nil {
		return BillTransaction{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return BillTransaction{}, apierror.Wrap(apierror.CodeInternal, "审核承兑交易失败", err)
	}
	defer tx.Rollback(ctx)
	before, err := lockBillTransaction(ctx, tx, id, actor)
	if err != nil {
		return BillTransaction{}, err
	}
	if before.Status != StatusDraft {
		return BillTransaction{}, apierror.New(apierror.CodeConflict, "仅草稿承兑交易可审核")
	}
	var posting time.Time
	var postingArg any
	if before.TransactionType != TransactionReallocate {
		if input.PostingDate == nil || strings.TrimSpace(*input.PostingDate) == "" {
			return BillTransaction{}, apierror.Validation("承兑交易审核条件不完整",
				map[string][]string{"postingDate": {"必填"}})
		}
		posting, err = parseDate(*input.PostingDate, "postingDate")
		if err != nil {
			return BillTransaction{}, err
		}
		postingArg = posting
	}
	bill, err := queryBill(ctx, tx, before.BillID, true)
	if err != nil {
		return BillTransaction{}, err
	}
	transactionInput := transactionToInput(before)
	_, _, err = validateTransaction(ctx, tx, transactionInput, bill, false)
	if err != nil {
		return BillTransaction{}, err
	}
	if before.TransactionType != TransactionReallocate {
		if before.BillAccountID == nil ||
			before.SettleAccountID == nil ||
			(before.TransactionType == TransactionDiscount &&
				before.Interest != nil && decimalPositive(*before.Interest) &&
				before.InterestAccountID == nil) {
			return BillTransaction{}, apierror.Validation("承兑交易审核条件不完整",
				map[string][]string{"posting": {"过账日期及所需科目必填"}})
		}
	}
	if err = validateBillAuditDate(before, bill); err != nil {
		return BillTransaction{}, err
	}
	now := time.Now().UTC()
	tag, err := tx.Exec(ctx, `UPDATE acc_bill_transaction SET status='audited',
		posting_date=$2,audited_at=$3,audited_by_id=$4,
		updated_at=(now() AT TIME ZONE 'utc')
		WHERE id=$1 AND status='draft'`, id, postingArg, now, actorID(actor))
	if err != nil {
		return BillTransaction{}, databaseWriteError("审核承兑交易失败", err)
	}
	if tag.RowsAffected() != 1 {
		return BillTransaction{}, apierror.New(apierror.CodeConflict, "承兑交易已被并发处理")
	}
	if before.TransactionType != TransactionReallocate {
		entries, entryErr := billTransactionEntries(before)
		if entryErr != nil {
			return BillTransaction{}, entryErr
		}
		if err = s.ledger.Post(ctx, tx, gl.Voucher{
			Type: "acc.bill_transaction", ID: id, No: transactionLabel(before),
			CompanyID: before.CompanyID, PostingDate: posting,
		}, entries); err != nil {
			return BillTransaction{}, err
		}
	}
	if err = replayBill(ctx, tx, bill.ID); err != nil {
		return BillTransaction{}, err
	}
	result, err := queryBillTransaction(ctx, tx, id, false)
	if err != nil {
		return BillTransaction{}, err
	}
	if err = writeAudit(ctx, tx, actor, "acc_bill_transaction", id, transactionLabel(result),
		"update", "audit", &result.CompanyID,
		changedValues(billTransactionSnapshot(before), billTransactionSnapshot(result))); err != nil {
		return BillTransaction{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return BillTransaction{}, databaseWriteError("审核承兑交易失败", err)
	}
	return result, nil
}

func (s *Service) VoidBillTransaction(
	ctx context.Context, actor *authz.Actor, id uuid.UUID,
) (BillTransaction, error) {
	if err := requirePermission(actor, "acc.bill_transaction:void"); err != nil {
		return BillTransaction{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return BillTransaction{}, apierror.Wrap(apierror.CodeInternal, "作废承兑交易失败", err)
	}
	defer tx.Rollback(ctx)
	before, err := lockBillTransaction(ctx, tx, id, actor)
	if err != nil {
		return BillTransaction{}, err
	}
	if before.Status != StatusAudited {
		return BillTransaction{}, apierror.New(apierror.CodeConflict, "仅已审核承兑交易可作废")
	}
	if _, err = queryBill(ctx, tx, before.BillID, true); err != nil {
		return BillTransaction{}, err
	}
	if before.TransactionType != TransactionReallocate {
		if err = s.ledger.Cancel(ctx, tx,
			gl.VoucherRef{Type: "acc.bill_transaction", ID: id}); err != nil {
			return BillTransaction{}, err
		}
	}
	if _, err = tx.Exec(ctx, `UPDATE acc_bill_transaction SET status='voided',
		updated_at=(now() AT TIME ZONE 'utc') WHERE id=$1`, id); err != nil {
		return BillTransaction{}, databaseWriteError("作废承兑交易失败", err)
	}
	if err = replayBill(ctx, tx, before.BillID); err != nil {
		return BillTransaction{}, err
	}
	result, err := queryBillTransaction(ctx, tx, id, false)
	if err != nil {
		return BillTransaction{}, err
	}
	if err = writeAudit(ctx, tx, actor, "acc_bill_transaction", id, transactionLabel(result),
		"update", "void", &result.CompanyID,
		changedValues(billTransactionSnapshot(before), billTransactionSnapshot(result))); err != nil {
		return BillTransaction{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return BillTransaction{}, databaseWriteError("作废承兑交易失败", err)
	}
	return result, nil
}

func (s *Service) OCRBillTransaction(
	ctx context.Context, actor *authz.Actor, input OCRInput,
) (OCRPrefill, error) {
	if err := requirePermission(actor, "acc.bill_transaction:create"); err != nil {
		return nil, err
	}
	if s.files == nil || s.ocr == nil {
		return nil, apierror.New(apierror.CodeInternal, "OCR 服务未配置")
	}
	if err := s.requireAccessibleFile(ctx, actor, input.FileID); err != nil {
		return nil, err
	}
	file, content, err := s.files.ReadStoredFile(ctx, input.FileID)
	if err != nil {
		return nil, err
	}
	result, err := s.ocr.Recognize(ctx, OCRBillTransaction, file, content)
	if err != nil {
		return nil, err
	}
	return OCRPrefill(result), nil
}

func (s *Service) QueryBillHoldings(
	ctx context.Context, actor *authz.Actor, query ListQuery,
) (BillHoldingList, error) {
	if err := requirePermission(actor, "acc.bill_holding:read"); err != nil {
		return BillHoldingList{}, err
	}
	if err := validateList(&query); err != nil {
		return BillHoldingList{}, err
	}
	built, err := filterbuild.Build(BillHoldingResourceMeta(), filterbuild.Query{
		Limit: query.Limit, Offset: query.Offset, Search: query.Search,
		Sort: query.Sort, Filter: query.Filter,
	})
	if err != nil {
		return BillHoldingList{}, err
	}
	built.Where, built.Args = companyScope(actor, built.Where, built.Args, "company_id")
	var result BillHoldingList
	if err = s.pool.QueryRow(ctx, `SELECT count(*) FROM acc_bill_holding`+
		built.Where, built.Args...).Scan(&result.Count); err != nil {
		return result, apierror.Wrap(apierror.CodeInternal, "统计持有承兑失败", err)
	}
	sql, args := appendPagination(`SELECT `+billHoldingColumns+
		` FROM acc_bill_holding`+built.Where+built.OrderBy, built.Args, query)
	rows, err := s.pool.Query(ctx, sql, args...)
	if err != nil {
		return result, apierror.Wrap(apierror.CodeInternal, "查询持有承兑失败", err)
	}
	defer rows.Close()
	result.Results = make([]BillHolding, 0, query.Limit)
	for rows.Next() {
		item, scanErr := scanBillHolding(rows)
		if scanErr != nil {
			return result, apierror.Wrap(apierror.CodeInternal, "读取持有承兑失败", scanErr)
		}
		result.Results = append(result.Results, item)
	}
	return result, rows.Err()
}

func (s *Service) GetBillHolding(
	ctx context.Context, actor *authz.Actor, id uuid.UUID,
) (BillHolding, error) {
	if err := requirePermission(actor, "acc.bill_holding:read"); err != nil {
		return BillHolding{}, err
	}
	where, args := companyScope(actor, " WHERE id=$1", []any{id}, "company_id")
	item, err := scanBillHolding(s.pool.QueryRow(ctx,
		`SELECT `+billHoldingColumns+` FROM acc_bill_holding`+where, args...))
	if err != nil {
		return BillHolding{}, notFound("持有承兑", err)
	}
	return item, nil
}

type transactionValues struct {
	occurredOn, postingDate                   any
	amount, discountRate, interest, netAmount any
}

func validateTransaction(
	ctx context.Context, tx pgx.Tx, input BillTransactionInput, bill Bill, create bool,
) (BillTransactionInput, transactionValues, error) {
	var values transactionValues
	input.TransactionType = upper(input.TransactionType)
	valid := map[string]bool{
		TransactionReceive: true, TransactionEndorse: true, TransactionSettle: true,
		TransactionDiscount: true, TransactionReallocate: true,
	}
	if !valid[input.TransactionType] || input.CompanyID == uuid.Nil ||
		input.BankAccountID == uuid.Nil || input.BillID == nil ||
		input.SubStart < 1 || input.SubEnd < input.SubStart {
		return input, values, apierror.Validation("承兑交易参数不合法",
			map[string][]string{"transaction": {"类型、公司、账户、票据与子票段必须有效"}})
	}
	var err error
	values.occurredOn, err = parseDate(input.OccurredOn, "occurredOn")
	if err != nil {
		return input, values, err
	}
	amount, err := parseDecimal(input.Amount, "amount", true, false)
	if err != nil {
		return input, values, err
	}
	if decimal.NewFromInt(input.SubEnd-input.SubStart+1).
		Cmp(amount.Mul(decimal.NewFromInt(100))) != 0 {
		return input, values, apierror.Validation("承兑交易参数不合法",
			map[string][]string{"subEnd": {"子票段长度必须等于金额×100"}})
	}
	values.amount = amount
	if bill.FaceAmount != nil {
		face, _ := decimal.NewFromString(*bill.FaceAmount)
		if decimal.NewFromInt(input.SubEnd).GreaterThan(face.Mul(decimal.NewFromInt(100))) {
			return input, values, apierror.Validation("承兑交易参数不合法",
				map[string][]string{"subEnd": {"子票段超出票面金额"}})
		}
	}
	if input.PostingDate != nil {
		values.postingDate, err = parseDate(*input.PostingDate, "postingDate")
		if err != nil {
			return input, values, err
		}
	}
	if err = validateBankAccounts(ctx, tx, input, create); err != nil {
		return input, values, err
	}
	requiresParty := input.TransactionType == TransactionReceive ||
		input.TransactionType == TransactionEndorse
	if requiresParty != (input.PartyType != nil && input.PartyID != nil) {
		return input, values, apierror.Validation("承兑交易参数不合法",
			map[string][]string{"partyId": {"接收/转让必须填写对手,其他类型必须为空"}})
	}
	if requiresParty {
		party := upper(*input.PartyType)
		input.PartyType = &party
		if err = validateParty(ctx, tx, party, *input.PartyID); err != nil {
			return input, values, err
		}
	}
	if input.TransactionType == TransactionDiscount {
		if input.DiscountOrg == nil || strings.TrimSpace(*input.DiscountOrg) == "" ||
			input.DiscountRate == nil || input.Interest == nil || input.NetAmount == nil {
			return input, values, apierror.Validation("承兑交易参数不合法",
				map[string][]string{"discount": {"贴现机构、利率、利息与实收金额必填"}})
		}
		rate, e := parseDecimal(*input.DiscountRate, "discountRate", false, true)
		if e != nil {
			return input, values, e
		}
		interest, e := parseDecimal(*input.Interest, "interest", false, true)
		if e != nil {
			return input, values, e
		}
		net, e := parseDecimal(*input.NetAmount, "netAmount", true, false)
		if e != nil {
			return input, values, e
		}
		if !interest.Add(net).Equal(amount) {
			return input, values, apierror.Validation("承兑交易参数不合法",
				map[string][]string{"netAmount": {"交易金额必须等于贴现利息+实收金额"}})
		}
		values.discountRate, values.interest, values.netAmount = rate, interest, net
	} else if input.DiscountOrg != nil || input.DiscountRate != nil ||
		input.Interest != nil || input.NetAmount != nil {
		return input, values, apierror.Validation("承兑交易参数不合法",
			map[string][]string{"discount": {"非贴现交易不得填写贴现字段"}})
	}
	if input.TransactionType == TransactionReallocate {
		if input.ToBankAccountID == nil || *input.ToBankAccountID == input.BankAccountID {
			return input, values, apierror.Validation("承兑交易参数不合法",
				map[string][]string{"toBankAccountId": {"调拨须选择不同的同公司转入账户"}})
		}
	} else if input.ToBankAccountID != nil {
		return input, values, apierror.Validation("承兑交易参数不合法",
			map[string][]string{"toBankAccountId": {"仅调拨可填写"}})
	}
	return input, values, nil
}

func validateBankAccounts(
	ctx context.Context, tx pgx.Tx, input BillTransactionInput, requireActive bool,
) error {
	activeClause := ""
	if requireActive {
		activeClause = " AND active"
	}
	var fromValid, toValid bool
	err := tx.QueryRow(ctx, `SELECT
		EXISTS(SELECT 1 FROM acc_bank_account WHERE id=$1 AND company_id=$3`+activeClause+`),
		($2::uuid IS NULL OR EXISTS(SELECT 1 FROM acc_bank_account
			WHERE id=$2 AND company_id=$3`+activeClause+`))`,
		input.BankAccountID, input.ToBankAccountID, input.CompanyID).Scan(&fromValid, &toValid)
	if err != nil || !fromValid || !toValid {
		return apierror.Validation("承兑交易参数不合法",
			map[string][]string{"bankAccountId": {"银行账户不属于公司或已停用"}})
	}
	return nil
}

func validateParty(ctx context.Context, tx pgx.Tx, partyType string, partyID uuid.UUID) error {
	var exists bool
	err := tx.QueryRow(ctx, `SELECT CASE $1::text
		WHEN 'supplier' THEN EXISTS(SELECT 1 FROM pur_supplier WHERE id=$2)
		WHEN 'customer' THEN EXISTS(SELECT 1 FROM sal_customers WHERE id=$2)
		WHEN 'company' THEN EXISTS(SELECT 1 FROM bas_company WHERE id=$2)
		WHEN 'employee' THEN EXISTS(SELECT 1 FROM hr_employees WHERE id=$2)
		ELSE false END`, lower(partyType), partyID).Scan(&exists)
	if err != nil || !exists {
		return apierror.Validation("承兑交易参数不合法",
			map[string][]string{"partyId": {"对手不存在"}})
	}
	return nil
}

func validateBillAuditDate(transaction BillTransaction, bill Bill) error {
	occurred, _ := time.Parse("2006-01-02", transaction.OccurredOn)
	due, _ := time.Parse("2006-01-02", bill.DueDate)
	if transaction.TransactionType == TransactionSettle && occurred.Before(due) {
		return apierror.New(apierror.CodeConflict, "兑付发生日期不能早于票据到期日")
	}
	if (transaction.TransactionType == TransactionReceive ||
		transaction.TransactionType == TransactionEndorse ||
		transaction.TransactionType == TransactionDiscount) && occurred.After(due) {
		return apierror.New(apierror.CodeConflict, "接收/转让/贴现发生日期不能晚于票据到期日")
	}
	if !bill.Transferable && (transaction.TransactionType == TransactionEndorse ||
		transaction.TransactionType == TransactionDiscount) {
		return apierror.New(apierror.CodeConflict, "该票据不得转让,禁止转让与贴现")
	}
	return nil
}

func billTransactionEntries(value BillTransaction) ([]gl.Entry, error) {
	amount, _ := decimal.NewFromString(value.Amount)
	partyType := ""
	if value.PartyType != nil {
		partyType = lower(*value.PartyType)
	}
	switch value.TransactionType {
	case TransactionReceive:
		return []gl.Entry{
			{AccountID: *value.BillAccountID, Debit: amount, Credit: decimal.Zero},
			{AccountID: *value.SettleAccountID, Debit: decimal.Zero, Credit: amount,
				PartyType: &partyType, PartyID: value.PartyID},
		}, nil
	case TransactionEndorse:
		return []gl.Entry{
			{AccountID: *value.SettleAccountID, Debit: amount, Credit: decimal.Zero,
				PartyType: &partyType, PartyID: value.PartyID},
			{AccountID: *value.BillAccountID, Debit: decimal.Zero, Credit: amount},
		}, nil
	case TransactionSettle:
		return []gl.Entry{
			{AccountID: *value.SettleAccountID, Debit: amount, Credit: decimal.Zero},
			{AccountID: *value.BillAccountID, Debit: decimal.Zero, Credit: amount},
		}, nil
	case TransactionDiscount:
		net, _ := decimal.NewFromString(*value.NetAmount)
		interest, _ := decimal.NewFromString(*value.Interest)
		result := []gl.Entry{
			{AccountID: *value.SettleAccountID, Debit: net, Credit: decimal.Zero},
		}
		if interest.IsPositive() {
			result = append(result, gl.Entry{
				AccountID: *value.InterestAccountID, Debit: interest, Credit: decimal.Zero,
			})
		}
		result = append(result, gl.Entry{
			AccountID: *value.BillAccountID, Debit: decimal.Zero, Credit: amount,
		})
		return result, nil
	default:
		return nil, apierror.New(apierror.CodeConflict, "调拨交易不生成总账分录")
	}
}

type holdingSegment struct {
	companyID, bankAccountID uuid.UUID
	start, end               int64
	acquiredOn               time.Time
	sourceID                 uuid.UUID
}

func replayBill(ctx context.Context, tx pgx.Tx, billID uuid.UUID) error {
	bill, err := queryBill(ctx, tx, billID, true)
	if err != nil {
		return err
	}
	rows, err := tx.Query(ctx, `SELECT id,doc_no,transaction_type,occurred_on,
		sub_start,sub_end,company_id,bank_account_id,to_bank_account_id
		FROM acc_bill_transaction WHERE bill_id=$1 AND status='audited'
		ORDER BY occurred_on,audited_at,id`, billID)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "读取票据交易链失败", err)
	}
	defer rows.Close()
	var segments []holdingSegment
	for rows.Next() {
		var id, companyID, bankAccountID uuid.UUID
		var toBankAccountID *uuid.UUID
		var docNo pgtype.Text
		var kind string
		var occurred time.Time
		var start, end int64
		if err = rows.Scan(&id, &docNo, &kind, &occurred, &start, &end,
			&companyID, &bankAccountID, &toBankAccountID); err != nil {
			return apierror.Wrap(apierror.CodeInternal, "读取票据交易链失败", err)
		}
		label := id.String()
		if docNo.Valid {
			label = docNo.String
		}
		if kind == "receive" {
			for _, segment := range segments {
				if overlaps(segment.start, segment.end, start, end) {
					return apierror.New(apierror.CodeConflict,
						"承兑库存校验失败:交易 "+label+" 接收段与现有持有段重叠")
				}
			}
			segments = append(segments, holdingSegment{
				companyID: companyID, bankAccountID: bankAccountID,
				start: start, end: end, acquiredOn: occurred, sourceID: id,
			})
			continue
		}
		var next []holdingSegment
		cursor := start
		sort.Slice(segments, func(left, right int) bool {
			return segments[left].start < segments[right].start
		})
		for _, segment := range segments {
			if segment.companyID != companyID || segment.bankAccountID != bankAccountID ||
				!overlaps(segment.start, segment.end, start, end) {
				next = append(next, segment)
				continue
			}
			if segment.start > cursor {
				return apierror.New(apierror.CodeConflict,
					fmt.Sprintf("承兑库存校验失败:交易 %s 段 %d-%d 未持有", label, cursor, segment.start-1))
			}
			if segment.start < start {
				left := segment
				left.end = start - 1
				next = append(next, left)
			}
			if segment.end >= cursor {
				cursor = segment.end + 1
			}
			if segment.end > end {
				right := segment
				right.start = end + 1
				next = append(next, right)
			}
		}
		if cursor <= end {
			return apierror.New(apierror.CodeConflict,
				fmt.Sprintf("承兑库存校验失败:交易 %s 段 %d-%d 未持有", label, cursor, end))
		}
		if kind == "reallocate" {
			if toBankAccountID == nil {
				return apierror.New(apierror.CodeConflict, "承兑库存校验失败:调拨缺少转入账户")
			}
			next = append(next, holdingSegment{
				companyID: companyID, bankAccountID: *toBankAccountID,
				start: start, end: end, acquiredOn: occurred, sourceID: id,
			})
		}
		segments = next
	}
	if err = rows.Err(); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `DELETE FROM acc_bill_holding WHERE bill_id=$1`, billID); err != nil {
		return databaseWriteError("重建持有承兑失败", err)
	}
	due, _ := time.Parse("2006-01-02", bill.DueDate)
	for _, segment := range segments {
		amount := decimal.NewFromInt(segment.end - segment.start + 1).Div(decimal.NewFromInt(100))
		_, err = tx.Exec(ctx, `INSERT INTO acc_bill_holding(
			bill_no,sub_start,sub_end,amount,due_date,acquired_on,company_id,
			bank_account_id,bill_id,source_transaction_id)
			VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, bill.BillNo, segment.start,
			segment.end, amount, due, segment.acquiredOn, segment.companyID,
			segment.bankAccountID, billID, segment.sourceID)
		if err != nil {
			return databaseWriteError("重建持有承兑失败", err)
		}
	}
	return nil
}

func overlaps(aStart, aEnd, bStart, bEnd int64) bool {
	return aStart <= bEnd && bStart <= aEnd
}

func registerBill(ctx context.Context, tx pgx.Tx, attrs BillAttrs) (Bill, error) {
	if err := validateBillAttrs(attrs); err != nil {
		return Bill{}, err
	}
	var existingID uuid.UUID
	err := tx.QueryRow(ctx, `SELECT id FROM acc_bill WHERE bill_no=$1 FOR UPDATE`,
		strings.TrimSpace(attrs.BillNo)).Scan(&existingID)
	if err == nil {
		return queryBill(ctx, tx, existingID, false)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return Bill{}, apierror.Wrap(apierror.CodeInternal, "锁定票据主档失败", err)
	}
	args, err := billArgs(attrs)
	if err != nil {
		return Bill{}, err
	}
	id := uuid.New()
	_, err = tx.Exec(ctx, `INSERT INTO acc_bill(
		id,bill_no,bill_kind,issue_date,due_date,face_amount,drawer_name,drawer_account,
		drawer_bank_name,drawer_bank_no,payee_name,payee_account,payee_bank_name,
		payee_bank_no,acceptor_name,acceptor_account,acceptor_bank_name,
		acceptor_bank_no,transferable,acceptance_date,remarks)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
		$18,$19,$20,$21)`, append([]any{id}, args...)...)
	if err != nil {
		return Bill{}, databaseWriteError("票据建档失败", err)
	}
	return queryBill(ctx, tx, id, false)
}

func validateBillAttrs(attrs BillAttrs) error {
	attrs.BillKind = upper(attrs.BillKind)
	validKind := attrs.BillKind == BillBankAcceptance ||
		attrs.BillKind == BillCommercialAcceptance ||
		attrs.BillKind == BillFinanceCompanyAcceptance
	if strings.TrimSpace(attrs.BillNo) == "" || !validKind ||
		strings.TrimSpace(attrs.DueDate) == "" {
		return apierror.Validation("票据主档参数不合法",
			map[string][]string{"bill": {"票号、种类与到期日必填"}})
	}
	if _, err := parseDate(attrs.DueDate, "dueDate"); err != nil {
		return err
	}
	if attrs.FaceAmount != nil {
		if _, err := parseDecimal(*attrs.FaceAmount, "faceAmount", true, false); err != nil {
			return err
		}
	}
	return nil
}

func billArgs(attrs BillAttrs) ([]any, error) {
	issue, err := dateArg(attrs.IssueDate, "issueDate")
	if err != nil {
		return nil, err
	}
	due, err := parseDate(attrs.DueDate, "dueDate")
	if err != nil {
		return nil, err
	}
	acceptance, err := dateArg(attrs.AcceptanceDate, "acceptanceDate")
	if err != nil {
		return nil, err
	}
	transferable := true
	if attrs.Transferable != nil {
		transferable = *attrs.Transferable
	}
	return []any{
		strings.TrimSpace(attrs.BillNo), lower(attrs.BillKind), issue, due,
		attrs.FaceAmount, attrs.DrawerName, attrs.DrawerAccount, attrs.DrawerBankName,
		attrs.DrawerBankNo, attrs.PayeeName, attrs.PayeeAccount, attrs.PayeeBankName,
		attrs.PayeeBankNo, attrs.AcceptorName, attrs.AcceptorAccount,
		attrs.AcceptorBankName, attrs.AcceptorBankNo, transferable, acceptance, attrs.Remarks,
	}, nil
}

func queryBill(ctx context.Context, tx pgx.Tx, id uuid.UUID, lock bool) (Bill, error) {
	suffix := ""
	if lock {
		suffix = " FOR UPDATE"
	}
	item, err := scanBill(tx.QueryRow(ctx,
		`SELECT `+billColumns+` FROM acc_bill WHERE id=$1`+suffix, id))
	if err != nil {
		return item, notFound("承兑票据", err)
	}
	return item, nil
}

func lockBillForActor(
	ctx context.Context, tx pgx.Tx, id uuid.UUID, actor *authz.Actor,
) (Bill, error) {
	item, err := queryBill(ctx, tx, id, true)
	if err != nil {
		return item, err
	}
	bypass, companies := actor.CompanyFilter()
	if !bypass {
		var accessible bool
		if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM acc_bill_transaction
			WHERE bill_id=$1 AND company_id=ANY($2::uuid[]))`, id, companies).
			Scan(&accessible); err != nil {
			return Bill{}, apierror.Wrap(apierror.CodeInternal, "检查票据公司范围失败", err)
		}
		if !accessible {
			return Bill{}, apierror.New(apierror.CodeNotFound, "承兑票据不存在")
		}
	}
	return item, nil
}

func queryBillTransaction(
	ctx context.Context, tx pgx.Tx, id uuid.UUID, lock bool,
) (BillTransaction, error) {
	suffix := ""
	if lock {
		suffix = " FOR UPDATE"
	}
	item, err := scanBillTransaction(tx.QueryRow(ctx,
		`SELECT `+billTransactionColumns+` FROM acc_bill_transaction WHERE id=$1`+suffix, id))
	if err != nil {
		return item, notFound("承兑交易", err)
	}
	return item, nil
}

func lockBillTransaction(
	ctx context.Context, tx pgx.Tx, id uuid.UUID, actor *authz.Actor,
) (BillTransaction, error) {
	item, err := queryBillTransaction(ctx, tx, id, true)
	if err != nil {
		return item, err
	}
	if err = requireCompany(actor, item.CompanyID, "承兑交易"); err != nil {
		return BillTransaction{}, err
	}
	return item, nil
}

func scanBill(row scanner) (Bill, error) {
	var item Bill
	var issueDate, dueDate, acceptanceDate pgtype.Date
	var face pgtype.Numeric
	var drawerName, drawerAccount, drawerBankName, drawerBankNo,
		payeeName, payeeAccount, payeeBankName, payeeBankNo,
		acceptorName, acceptorAccount, acceptorBankName, acceptorBankNo,
		remarks pgtype.Text
	err := row.Scan(&item.ID, &item.BillNo, &item.BillKind, &issueDate, &dueDate,
		&face, &drawerName, &drawerAccount, &drawerBankName, &drawerBankNo,
		&payeeName, &payeeAccount, &payeeBankName, &payeeBankNo, &acceptorName,
		&acceptorAccount, &acceptorBankName, &acceptorBankNo, &item.Transferable,
		&acceptanceDate, &remarks, &item.InsertedAt, &item.UpdatedAt)
	if err != nil {
		return item, err
	}
	item.BillKind, item.IssueDate, item.DueDate = upper(item.BillKind), datePointer(issueDate), dateValue(dueDate)
	item.FaceAmount = decimalPointer(face)
	item.DrawerName, item.DrawerAccount = pgText(drawerName), pgText(drawerAccount)
	item.DrawerBankName, item.DrawerBankNo = pgText(drawerBankName), pgText(drawerBankNo)
	item.PayeeName, item.PayeeAccount = pgText(payeeName), pgText(payeeAccount)
	item.PayeeBankName, item.PayeeBankNo = pgText(payeeBankName), pgText(payeeBankNo)
	item.AcceptorName, item.AcceptorAccount = pgText(acceptorName), pgText(acceptorAccount)
	item.AcceptorBankName, item.AcceptorBankNo = pgText(acceptorBankName), pgText(acceptorBankNo)
	item.AcceptanceDate, item.Remarks = datePointer(acceptanceDate), pgText(remarks)
	item.InsertedAt, item.UpdatedAt = item.InsertedAt.UTC(), item.UpdatedAt.UTC()
	return item, nil
}

func scanBillTransaction(row scanner) (BillTransaction, error) {
	var item BillTransaction
	var docNo, partyType, discountOrg, remarks pgtype.Text
	var occurredOn, postingDate pgtype.Date
	var amount, discountRate, interest, netAmount pgtype.Numeric
	var auditedAt pgtype.Timestamp
	err := row.Scan(&item.ID, &docNo, &item.TransactionType, &occurredOn,
		&item.SubStart, &item.SubEnd, &amount, &partyType, &item.PartyID,
		&discountOrg, &discountRate, &interest, &netAmount, &postingDate,
		&item.Status, &auditedAt, &remarks, &item.InsertedAt, &item.UpdatedAt,
		&item.CompanyID, &item.BankAccountID, &item.ToBankAccountID, &item.BillID,
		&item.BillAccountID, &item.SettleAccountID, &item.InterestAccountID,
		&item.CreatedByID, &item.AuditedByID)
	if err != nil {
		return item, err
	}
	item.DocNo, item.PartyType, item.DiscountOrg, item.Remarks =
		pgText(docNo), upperText(partyType), pgText(discountOrg), pgText(remarks)
	item.OccurredOn, item.PostingDate = dateValue(occurredOn), datePointer(postingDate)
	item.Amount, item.DiscountRate, item.Interest, item.NetAmount =
		decimalValue(amount), decimalPointer(discountRate), decimalPointer(interest), decimalPointer(netAmount)
	item.TransactionType, item.Status = upper(item.TransactionType), upper(item.Status)
	if auditedAt.Valid {
		value := auditedAt.Time.UTC()
		item.AuditedAt = &value
	}
	item.InsertedAt, item.UpdatedAt = item.InsertedAt.UTC(), item.UpdatedAt.UTC()
	return item, nil
}

func scanBillHolding(row scanner) (BillHolding, error) {
	var item BillHolding
	var amount pgtype.Numeric
	var dueDate, acquiredOn pgtype.Date
	err := row.Scan(&item.ID, &item.BillNo, &item.SubStart, &item.SubEnd, &amount,
		&dueDate, &acquiredOn, &item.InsertedAt, &item.CompanyID,
		&item.BankAccountID, &item.BillID, &item.SourceTransactionID)
	if err != nil {
		return item, err
	}
	item.Amount, item.DueDate, item.AcquiredOn =
		decimalValue(amount), dateValue(dueDate), dateValue(acquiredOn)
	item.InsertedAt = item.InsertedAt.UTC()
	return item, nil
}

func upperText(value pgtype.Text) *string {
	if !value.Valid {
		return nil
	}
	result := upper(value.String)
	return &result
}

func lowerOptional(value *string) any {
	if value == nil {
		return nil
	}
	return lower(*value)
}

func transactionLabel(value BillTransaction) string {
	if value.DocNo != nil && *value.DocNo != "" {
		return *value.DocNo
	}
	return value.ID.String()
}

func decimalPositive(value string) bool {
	result, err := decimal.NewFromString(value)
	return err == nil && result.IsPositive()
}

func optionalDecimalEqual(left, right *string) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	a, aErr := decimal.NewFromString(*left)
	b, bErr := decimal.NewFromString(*right)
	return aErr == nil && bErr == nil && a.Equal(b)
}

func uuidPointerEqual(left, right *uuid.UUID) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

func billToAttrs(value Bill) BillAttrs {
	transferable := value.Transferable
	return BillAttrs{
		BillNo: value.BillNo, BillKind: value.BillKind, IssueDate: value.IssueDate,
		DueDate: value.DueDate, FaceAmount: value.FaceAmount,
		DrawerName: value.DrawerName, DrawerAccount: value.DrawerAccount,
		DrawerBankName: value.DrawerBankName, DrawerBankNo: value.DrawerBankNo,
		PayeeName: value.PayeeName, PayeeAccount: value.PayeeAccount,
		PayeeBankName: value.PayeeBankName, PayeeBankNo: value.PayeeBankNo,
		AcceptorName: value.AcceptorName, AcceptorAccount: value.AcceptorAccount,
		AcceptorBankName: value.AcceptorBankName, AcceptorBankNo: value.AcceptorBankNo,
		Transferable: &transferable, AcceptanceDate: value.AcceptanceDate, Remarks: value.Remarks,
	}
}

func overlayBillAttrs(target *BillAttrs, input BillUpdateInput) {
	if input.BillKind != nil {
		target.BillKind = *input.BillKind
	}
	applyOptionalString(&target.IssueDate, input.IssueDate)
	if input.DueDate != nil {
		target.DueDate = *input.DueDate
	}
	applyOptionalString(&target.FaceAmount, input.FaceAmount)
	applyOptionalString(&target.DrawerName, input.DrawerName)
	applyOptionalString(&target.DrawerAccount, input.DrawerAccount)
	applyOptionalString(&target.DrawerBankName, input.DrawerBankName)
	applyOptionalString(&target.DrawerBankNo, input.DrawerBankNo)
	applyOptionalString(&target.PayeeName, input.PayeeName)
	applyOptionalString(&target.PayeeAccount, input.PayeeAccount)
	applyOptionalString(&target.PayeeBankName, input.PayeeBankName)
	applyOptionalString(&target.PayeeBankNo, input.PayeeBankNo)
	applyOptionalString(&target.AcceptorName, input.AcceptorName)
	applyOptionalString(&target.AcceptorAccount, input.AcceptorAccount)
	applyOptionalString(&target.AcceptorBankName, input.AcceptorBankName)
	applyOptionalString(&target.AcceptorBankNo, input.AcceptorBankNo)
	if input.Transferable != nil {
		target.Transferable = input.Transferable
	}
	applyOptionalString(&target.AcceptanceDate, input.AcceptanceDate)
	applyOptionalString(&target.Remarks, input.Remarks)
}

func transactionToInput(value BillTransaction) BillTransactionInput {
	return BillTransactionInput{
		DocNo: value.DocNo, TransactionType: value.TransactionType, OccurredOn: value.OccurredOn,
		SubStart: value.SubStart, SubEnd: value.SubEnd, Amount: value.Amount,
		PartyType: value.PartyType, PartyID: value.PartyID, DiscountOrg: value.DiscountOrg,
		DiscountRate: value.DiscountRate, Interest: value.Interest, NetAmount: value.NetAmount,
		PostingDate: value.PostingDate, Remarks: value.Remarks, CompanyID: value.CompanyID,
		BankAccountID: value.BankAccountID, ToBankAccountID: value.ToBankAccountID,
		BillID: &value.BillID, BillAccountID: value.BillAccountID,
		SettleAccountID: value.SettleAccountID, InterestAccountID: value.InterestAccountID,
	}
}

func overlayTransaction(target *BillTransactionInput, input BillTransactionUpdateInput) {
	applyOptionalString(&target.DocNo, input.DocNo)
	if input.OccurredOn != nil {
		target.OccurredOn = *input.OccurredOn
	}
	if input.SubStart != nil {
		target.SubStart = *input.SubStart
	}
	if input.SubEnd != nil {
		target.SubEnd = *input.SubEnd
	}
	if input.Amount != nil {
		target.Amount = *input.Amount
	}
	applyOptionalString(&target.PartyType, input.PartyType)
	applyOptionalUUID(&target.PartyID, input.PartyID)
	applyOptionalString(&target.DiscountOrg, input.DiscountOrg)
	applyOptionalString(&target.DiscountRate, input.DiscountRate)
	applyOptionalString(&target.Interest, input.Interest)
	applyOptionalString(&target.NetAmount, input.NetAmount)
	applyOptionalString(&target.PostingDate, input.PostingDate)
	applyOptionalString(&target.Remarks, input.Remarks)
	if input.BankAccountID != nil {
		target.BankAccountID = *input.BankAccountID
	}
	applyOptionalUUID(&target.ToBankAccountID, input.ToBankAccountID)
	if input.BillID != nil {
		target.BillID = input.BillID
	}
	applyOptionalUUID(&target.BillAccountID, input.BillAccountID)
	applyOptionalUUID(&target.SettleAccountID, input.SettleAccountID)
	applyOptionalUUID(&target.InterestAccountID, input.InterestAccountID)
}

func billSnapshot(value Bill) map[string]any {
	return map[string]any{
		"bill_no": value.BillNo, "bill_kind": value.BillKind,
		"issue_date": value.IssueDate, "due_date": value.DueDate,
		"face_amount": value.FaceAmount, "transferable": value.Transferable,
		"remarks": value.Remarks,
	}
}

func billTransactionSnapshot(value BillTransaction) map[string]any {
	return map[string]any{
		"doc_no": value.DocNo, "transaction_type": value.TransactionType,
		"occurred_on": value.OccurredOn, "sub_start": value.SubStart,
		"sub_end": value.SubEnd, "amount": value.Amount, "party_type": value.PartyType,
		"party_id": value.PartyID, "discount_org": value.DiscountOrg,
		"discount_rate": value.DiscountRate, "interest": value.Interest,
		"net_amount": value.NetAmount, "posting_date": value.PostingDate,
		"status": value.Status, "company_id": value.CompanyID,
		"bank_account_id": value.BankAccountID, "to_bank_account_id": value.ToBankAccountID,
		"bill_id": value.BillID, "bill_account_id": value.BillAccountID,
		"settle_account_id":   value.SettleAccountID,
		"interest_account_id": value.InterestAccountID,
	}
}
