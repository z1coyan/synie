package banking

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/engines/gl"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/audit"
	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/platform/numbering"
)

type quickJournalAdapter struct {
	numberer Numberer
	ledger   Ledger
}

func (w *quickJournalAdapter) CreateAndAudit(
	ctx context.Context, tx pgx.Tx, actor *authz.Actor, input QuickJournalInput,
) (uuid.UUID, error) {
	if err := require(actor, "acc.gl_journal", "create"); err != nil {
		return uuid.Nil, err
	}
	if err := require(actor, "acc.gl_journal", "audit"); err != nil {
		return uuid.Nil, err
	}
	no, err := w.numberer.NextInTx(ctx, tx, numbering.NextInput{
		Resource: "acc.gl_journal",
		Values: map[string]any{
			"company_id": input.CompanyID,
			"date":       input.PostingDate,
		},
	})
	if err != nil {
		return uuid.Nil, err
	}
	journalID := uuid.New()
	_, err = tx.Exec(ctx, `INSERT INTO acc_gl_journal(
		id,voucher_no,date,posting_date,remarks,status,company_id,created_by_id)
		VALUES($1,$2,$3,$3,$4,'draft',$5,$6)`,
		journalID, no, input.PostingDate, input.Summary, input.CompanyID, actorID(actor))
	if err != nil {
		return uuid.Nil, writeError("创建快速对账凭证失败", err)
	}
	if err := writeAudit(ctx, tx, actor, "acc_gl_journal", journalID, no,
		"create", "create", &input.CompanyID, created(map[string]any{
			"voucher_no": no, "date": input.PostingDate.Format(time.DateOnly),
			"posting_date": input.PostingDate.Format(time.DateOnly),
			"remarks":      input.Summary, "company_id": input.CompanyID,
		})); err != nil {
		return uuid.Nil, err
	}

	type accountCurrency struct {
		id       uuid.UUID
		currency *uuid.UUID
	}
	rows, err := tx.Query(ctx, `SELECT id,currency_id FROM bas_account
		WHERE id=ANY($1::uuid[])`, []uuid.UUID{input.BankLedgerAccountID, input.CounterAccountID})
	if err != nil {
		return uuid.Nil, apierror.Wrap(apierror.CodeInternal, "读取快速对账科目失败", err)
	}
	currencies := make(map[uuid.UUID]*uuid.UUID, 2)
	for rows.Next() {
		var value accountCurrency
		if err := rows.Scan(&value.id, &value.currency); err != nil {
			rows.Close()
			return uuid.Nil, apierror.Wrap(apierror.CodeInternal, "读取快速对账科目失败", err)
		}
		currencies[value.id] = value.currency
	}
	rows.Close()
	if len(currencies) != 2 {
		return uuid.Nil, apierror.Validation("快速对账参数不合法",
			map[string][]string{"counterAccountId": {"科目不存在"}})
	}

	zero := decimal.Zero
	entries := make([]gl.Entry, 2)
	if input.Income {
		entries[0] = gl.Entry{
			AccountID: input.BankLedgerAccountID, CurrencyID: currencies[input.BankLedgerAccountID],
			Debit: input.Amount, Credit: zero, Remarks: input.Summary,
		}
		entries[1] = gl.Entry{
			AccountID: input.CounterAccountID, CurrencyID: currencies[input.CounterAccountID],
			Debit: zero, Credit: input.Amount, Remarks: input.Summary,
		}
	} else {
		entries[0] = gl.Entry{
			AccountID: input.CounterAccountID, CurrencyID: currencies[input.CounterAccountID],
			Debit: input.Amount, Credit: zero, Remarks: input.Summary,
		}
		entries[1] = gl.Entry{
			AccountID: input.BankLedgerAccountID, CurrencyID: currencies[input.BankLedgerAccountID],
			Debit: zero, Credit: input.Amount, Remarks: input.Summary,
		}
	}
	for index, entry := range entries {
		lineID := uuid.New()
		_, err := tx.Exec(ctx, `INSERT INTO acc_gl_journal_line(
			id,idx,debit,credit,remarks,journal_id,company_id,account_id,currency_id)
			VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
			lineID, index+1, entry.Debit, entry.Credit, entry.Remarks,
			journalID, input.CompanyID, entry.AccountID, entry.CurrencyID)
		if err != nil {
			return uuid.Nil, writeError("创建快速对账凭证行失败", err)
		}
		if err := audit.Write(ctx, tx, actor, audit.Entry{
			Resource: "acc_gl_journal_line", RecordID: lineID,
			RecordLabel: fmt.Sprintf("%s#%d", no, index+1),
			ActionType:  "create", ActionName: "create", CompanyID: &input.CompanyID,
			Changes: audit.Created(map[string]any{
				"idx": index + 1, "debit": entry.Debit.String(),
				"credit": entry.Credit.String(), "journal_id": journalID,
				"company_id": input.CompanyID, "account_id": entry.AccountID,
				"currency_id": entry.CurrencyID, "remarks": entry.Remarks,
			}, []string{
				"idx", "debit", "credit", "journal_id", "company_id",
				"account_id", "currency_id", "remarks",
			}),
		}); err != nil {
			return uuid.Nil, apierror.Wrap(apierror.CodeInternal, "写入快速凭证行审计失败", err)
		}
	}
	if err := w.ledger.Post(ctx, tx, gl.Voucher{
		Type: "acc.gl_journal", ID: journalID, No: no,
		CompanyID: input.CompanyID, PostingDate: input.PostingDate,
	}, entries); err != nil {
		return uuid.Nil, err
	}
	now := time.Now().UTC()
	command, err := tx.Exec(ctx, `UPDATE acc_gl_journal
		SET status='audited',submitted_at=$2,submitted_by_id=$3,updated_at=$2
		WHERE id=$1 AND status='draft'`, journalID, now, actorID(actor))
	if err != nil {
		return uuid.Nil, writeError("审核快速对账凭证失败", err)
	}
	if command.RowsAffected() != 1 {
		return uuid.Nil, conflict("快速对账凭证已被并发处理")
	}
	if err := writeAudit(ctx, tx, actor, "acc_gl_journal", journalID, no,
		"update", "audit", &input.CompanyID, map[string]audit.Change{
			"status":          {"from": "draft", "to": "audited"},
			"submitted_at":    {"to": now},
			"submitted_by_id": {"to": actorID(actor)},
		}); err != nil {
		return uuid.Nil, err
	}
	return journalID, nil
}
