// Package gl is the only application path that appends to or changes the
// lifecycle flags of acc_gl_entry. Callers own the transaction so a source
// document state change and its ledger facts commit atomically.
package gl

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/db/dbgen"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
)

var partyAccountRoles = map[string]struct{}{
	"unbilled_receivable": {},
	"receivable":          {},
	"advance_received":    {},
	"unbilled_payable":    {},
	"payable":             {},
	"advance_paid":        {},
	"other_payable":       {},
}

type account struct {
	name      string
	companyID uuid.UUID
	isGroup   bool
	active    bool
	role      string
}

// Post validates and appends one fact for every entry. It never begins,
// commits, or rolls back tx.
func Post(
	ctx context.Context,
	tx pgx.Tx,
	voucher Voucher,
	entries []Entry,
	options ...PostOptions,
) error {
	option := PostOptions{}
	if len(options) > 0 {
		option = options[0]
	}
	if err := validateVoucher(voucher); err != nil {
		return err
	}
	if err := validateShape(entries, option.AllowNegative); err != nil {
		return err
	}
	q := dbgen.New(tx)
	accounts, err := loadAccounts(ctx, q, voucher.CompanyID, entries)
	if err != nil {
		return err
	}
	if err := validateRoleParties(accounts, entries); err != nil {
		return err
	}
	for _, entry := range entries {
		if _, err := q.InsertGLEntry(ctx, dbgen.InsertGLEntryParams{
			CompanyID: voucher.CompanyID, AccountID: entry.AccountID,
			CurrencyID: entry.CurrencyID, PostingDate: date(voucher.PostingDate),
			Debit: entry.Debit, Credit: entry.Credit,
			PartyType: text(entry.PartyType), PartyID: entry.PartyID,
			VoucherType: voucher.Type, VoucherID: voucher.ID, VoucherNo: voucher.No,
			Remarks: text(entry.Remarks), IsReversal: entry.IsReversal,
		}); err != nil {
			return apierror.Wrap(apierror.CodeInternal, "写入总账分录失败", err)
		}
	}
	return nil
}

// Cancel marks all currently live facts for a voucher as cancelled. Repeated
// calls are harmless. The caller owns tx.
func Cancel(ctx context.Context, tx pgx.Tx, ref VoucherRef) error {
	if err := validateRef(ref); err != nil {
		return err
	}
	if _, err := dbgen.New(tx).CancelGLEntriesForVoucher(
		ctx,
		dbgen.CancelGLEntriesForVoucherParams{VoucherType: ref.Type, VoucherID: ref.ID},
	); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "作废总账分录失败", err)
	}
	return nil
}

// Reverse locks the original live group, appends its negated red group using
// postingDate, then marks the originals as reversed. Repeated reversal is
// rejected. The caller owns tx.
func Reverse(
	ctx context.Context,
	tx pgx.Tx,
	ref VoucherRef,
	postingDate time.Time,
) error {
	if err := validateRef(ref); err != nil {
		return err
	}
	if postingDate.IsZero() {
		return apierror.Validation("总账红冲参数不合法", map[string][]string{
			"postingDate": {"必填"},
		})
	}
	q := dbgen.New(tx)
	originals, err := q.LockReversibleGLEntriesForVoucher(
		ctx,
		dbgen.LockReversibleGLEntriesForVoucherParams{
			VoucherType: ref.Type,
			VoucherID:   ref.ID,
		},
	)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "读取待红冲总账分录失败", err)
	}
	if len(originals) == 0 {
		return apierror.New(apierror.CodeConflict, "该单据没有可红冲的分录")
	}
	first := originals[0]
	entries := make([]Entry, 0, len(originals))
	ids := make([]uuid.UUID, 0, len(originals))
	for _, original := range originals {
		remark := "红冲"
		if original.Remarks.Valid && original.Remarks.String != "" {
			remark += ":" + original.Remarks.String
		}
		entries = append(entries, Entry{
			AccountID: original.AccountID, CurrencyID: original.CurrencyID,
			Debit: original.Debit.Neg(), Credit: original.Credit.Neg(),
			PartyType: optionalText(original.PartyType), PartyID: original.PartyID,
			Remarks: &remark, IsReversal: true,
		})
		ids = append(ids, original.ID)
	}
	if err := Post(ctx, tx, Voucher{
		Type: ref.Type, ID: ref.ID, No: first.VoucherNo,
		CompanyID: first.CompanyID, PostingDate: postingDate,
	}, entries, PostOptions{AllowNegative: true}); err != nil {
		return err
	}
	updated, err := q.MarkGLEntriesReversed(ctx, ids)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "标记原总账分录已红冲失败", err)
	}
	if updated != int64(len(ids)) {
		return apierror.New(apierror.CodeConflict, "总账分录已被并发红冲")
	}
	return nil
}

func validateVoucher(voucher Voucher) error {
	fields := map[string][]string{}
	if strings.TrimSpace(voucher.Type) == "" || len(voucher.Type) > 64 {
		fields["voucherType"] = []string{"必填且最多 64 个字符"}
	}
	if voucher.ID == uuid.Nil {
		fields["voucherId"] = []string{"必填"}
	}
	if strings.TrimSpace(voucher.No) == "" || len(voucher.No) > 64 {
		fields["voucherNo"] = []string{"必填且最多 64 个字符"}
	}
	if voucher.CompanyID == uuid.Nil {
		fields["companyId"] = []string{"必填"}
	}
	if voucher.PostingDate.IsZero() {
		fields["postingDate"] = []string{"必填"}
	}
	if len(fields) > 0 {
		return apierror.Validation("总账过账参数不合法", fields)
	}
	return nil
}

func validateRef(ref VoucherRef) error {
	if strings.TrimSpace(ref.Type) == "" || ref.ID == uuid.Nil {
		return apierror.Validation("总账来源单据参数不合法", map[string][]string{
			"voucher": {"来源单据类型和 ID 必填"},
		})
	}
	return nil
}

func validateShape(entries []Entry, allowNegative bool) error {
	if len(entries) < 2 {
		return ledgerValidation("分录不少于两行")
	}
	debitTotal, creditTotal := decimal.Zero, decimal.Zero
	for _, entry := range entries {
		debitNonzero := !entry.Debit.IsZero()
		creditNonzero := !entry.Credit.IsZero()
		if debitNonzero == creditNonzero ||
			(!allowNegative && (entry.Debit.IsNegative() || entry.Credit.IsNegative())) {
			if allowNegative {
				return ledgerValidation("每行借贷必须恰一边非零")
			}
			return ledgerValidation("每行借贷必须恰一边大于零")
		}
		if (entry.PartyType == nil) != (entry.PartyID == nil) {
			return ledgerValidation("对手类型与对手必须同时填写")
		}
		debitTotal = debitTotal.Add(entry.Debit)
		creditTotal = creditTotal.Add(entry.Credit)
	}
	if !debitTotal.Equal(creditTotal) {
		return ledgerValidation("借贷不平")
	}
	return nil
}

func loadAccounts(
	ctx context.Context,
	q *dbgen.Queries,
	companyID uuid.UUID,
	entries []Entry,
) (map[uuid.UUID]account, error) {
	ids := make([]uuid.UUID, 0, len(entries))
	seen := make(map[uuid.UUID]struct{}, len(entries))
	for _, entry := range entries {
		if _, ok := seen[entry.AccountID]; ok {
			continue
		}
		seen[entry.AccountID] = struct{}{}
		ids = append(ids, entry.AccountID)
	}
	rows, err := q.GetGLAccounts(ctx, ids)
	if err != nil {
		return nil, apierror.Wrap(apierror.CodeInternal, "读取过账科目失败", err)
	}
	accounts := make(map[uuid.UUID]account, len(rows))
	for _, row := range rows {
		role := ""
		if row.Role.Valid {
			role = row.Role.String
		}
		accounts[row.ID] = account{
			name: row.Name, companyID: row.CompanyID,
			isGroup: row.IsGroup, active: row.Active, role: role,
		}
	}
	for _, id := range ids {
		item, ok := accounts[id]
		switch {
		case !ok:
			return nil, ledgerValidation("科目不存在")
		case item.companyID != companyID:
			return nil, ledgerValidation("科目必须属于单据公司")
		case item.isGroup:
			return nil, ledgerValidation("汇总科目不能入账")
		case !item.active:
			return nil, ledgerValidation("停用科目不能入账")
		}
	}
	return accounts, nil
}

func validateRoleParties(accounts map[uuid.UUID]account, entries []Entry) error {
	for _, entry := range entries {
		item := accounts[entry.AccountID]
		if _, ok := partyAccountRoles[strings.ToLower(item.role)]; ok && entry.PartyID == nil && !entry.IsReversal {
			return ledgerValidation(fmt.Sprintf("往来科目「%s」的分录必须填写对手", item.name))
		}
	}
	return nil
}

func ledgerValidation(message string) error {
	return apierror.Validation("总账过账校验失败", map[string][]string{
		"entries": {message},
	})
}

func date(value time.Time) pgtype.Date {
	return pgtype.Date{Time: value, Valid: true}
}

func text(value *string) pgtype.Text {
	if value == nil {
		return pgtype.Text{}
	}
	return pgtype.Text{String: *value, Valid: true}
}

func optionalText(value pgtype.Text) *string {
	if !value.Valid {
		return nil
	}
	result := value.String
	return &result
}
