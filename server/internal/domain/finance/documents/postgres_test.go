package documents

import (
	"context"
	"fmt"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/platform/numbering"
)

type testNumberer struct{ value atomic.Int64 }

func (n *testNumberer) NextInTx(
	_ context.Context, _ pgx.Tx, input numbering.NextInput,
) (string, error) {
	return fmt.Sprintf("DOC-%s-%d", input.Resource, n.value.Add(1)), nil
}

func TestPostgresFinanceDocumentsAtomicLifecyclesAndBillReplay(t *testing.T) {
	databaseURL := os.Getenv("SYNIE_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("set SYNIE_TEST_DATABASE_URL to run the real PostgreSQL test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	suffix := uuid.NewString()
	currencyID, companyID, employeeID, userID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	partyAccountID, amountAccountID, paymentAccountID := uuid.New(), uuid.New(), uuid.New()
	billAccountID, settleAccountID, bankAccountID := uuid.New(), uuid.New(), uuid.New()
	ids := []uuid.UUID{
		partyAccountID, amountAccountID, paymentAccountID, billAccountID, settleAccountID,
	}
	if _, err = pool.Exec(ctx, `INSERT INTO bas_currency(id,name,iso_code)
		VALUES($1,$2,$3)`, currencyID, "测试币"+suffix, "T"+suffix[:2]); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO bas_company(
		id,code,name,short_name,base_currency_id) VALUES($1,$2,$3,$4,$5)`,
		companyID, "C"+suffix, "测试公司"+suffix, "测试", currencyID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO sys_user(
		id,username,name,hashed_password) VALUES($1,$2,$3,'test')`,
		userID, "finance-"+suffix, "财务测试"); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO hr_employees(id,code,name)
		VALUES($1,$2,$3)`, employeeID, "E"+suffix, "员工"+suffix); err != nil {
		t.Fatal(err)
	}
	roles := []*string{stringPointer("other_payable"), nil, nil, nil, stringPointer("payable")}
	for index, id := range ids {
		if _, err = pool.Exec(ctx, `INSERT INTO bas_account(
			id,code,name,direction,company_id,currency_id,role)
			VALUES($1,$2,$3,'debit',$4,$5,$6)`, id,
			fmt.Sprintf("A%d-%s", index, suffix), fmt.Sprintf("科目%d", index),
			companyID, currencyID, roles[index]); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = pool.Exec(ctx, `INSERT INTO acc_bank_account(
		id,alias,bank_name,holder_name,account_no,company_id,currency_id,account_id)
		VALUES($1,$2,'测试银行','测试户',$3,$4,$5,$6)`,
		bankAccountID, "测试户"+suffix, suffix, companyID, currencyID, paymentAccountID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cleanupCancel()
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM sys_audit_log WHERE actor_id=$1`, userID)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM acc_gl_entry WHERE company_id=$1`, companyID)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM acc_bill_holding WHERE company_id=$1`, companyID)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM acc_bill_transaction WHERE company_id=$1`, companyID)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM acc_bill WHERE bill_no LIKE $1`, "BILL-"+suffix+"%")
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM acc_expense_report_item WHERE company_id=$1`, companyID)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM acc_expense_report WHERE company_id=$1`, companyID)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM acc_vat_invoice WHERE company_id=$1`, companyID)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM acc_bank_account WHERE id=$1`, bankAccountID)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM bas_account WHERE company_id=$1`, companyID)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM hr_employees WHERE id=$1`, employeeID)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM sys_user WHERE id=$1`, userID)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM bas_company WHERE id=$1`, companyID)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM bas_currency WHERE id=$1`, currencyID)
	})

	permissions := map[string]struct{}{}
	for _, code := range []string{
		"acc.vat_invoice:create", "acc.vat_invoice:read", "acc.vat_invoice:update",
		"acc.vat_invoice:delete", "acc.vat_invoice:audit", "acc.vat_invoice:void",
		"acc.vat_invoice:reverse", "acc.expense_report:create", "acc.expense_report:read",
		"acc.expense_report:update", "acc.expense_report:delete", "acc.expense_report:audit",
		"acc.expense_report:void", "acc.bill_transaction:create",
		"acc.bill_transaction:read", "acc.bill_transaction:update",
		"acc.bill_transaction:delete", "acc.bill_transaction:audit",
		"acc.bill_transaction:void", "acc.bill_holding:read",
		"acc.bill:read", "acc.bill:update", "acc.bill:delete",
	} {
		permissions[code] = struct{}{}
	}
	actor := &authz.Actor{
		UserID: userID, Username: "finance-test", Permissions: permissions,
		CompanyIDs: []uuid.UUID{companyID},
	}
	service := NewService(pool, Dependencies{Numberer: &testNumberer{}})
	today, future := "2026-07-26", "2026-12-31"

	t.Run("invoice expense atomic chain and reference guard", func(t *testing.T) {
		invoiceNo := "INV-" + suffix
		zero, hundred := "0", "100"
		invoice, createErr := service.CreateVatInvoice(ctx, actor, VatInvoiceInput{
			CompanyID: companyID, Direction: DirectionInbound, InvoiceDate: &today,
			PartyType: PartyEmployee, PartyID: employeeID, InvoiceKind: InvoiceNormal,
			InvoiceNo: &invoiceNo, Items: "[]", NetTotal: &hundred, TaxTotal: &zero,
			GrossTotal: &hundred, PartyAccountID: &partyAccountID,
			AmountAccountID: &amountAccountID,
		})
		if createErr != nil {
			t.Fatal(createErr)
		}
		invoice, err = service.AuditVatInvoice(ctx, actor, invoice.ID, today)
		if err != nil || invoice.Status != StatusAudited {
			t.Fatalf("audit: %#v %v", invoice, err)
		}
		report, err := service.CreateExpenseReport(ctx, actor, ExpenseReportInput{
			CompanyID: companyID, ExpenseDate: today, EmployeeID: employeeID,
			PaymentAccountID: paymentAccountID,
		})
		if err != nil {
			t.Fatal(err)
		}
		_, err = service.CreateExpenseReportItem(ctx, actor, ExpenseReportItemInput{
			ReportID: report.ID, Idx: 1, Kind: ExpenseInvoiced, InvoiceID: &invoice.ID,
		})
		if err != nil {
			t.Fatal(err)
		}
		report, err = service.AuditExpenseReport(ctx, actor, report.ID, today)
		if err != nil || report.Status != StatusAudited {
			t.Fatalf("report audit: %#v %v", report, err)
		}
		if _, err = service.VoidVatInvoice(ctx, actor, invoice.ID); err == nil {
			t.Fatal("referenced invoice void must roll back")
		}
		if _, err = service.VoidExpenseReport(ctx, actor, report.ID); err != nil {
			t.Fatal(err)
		}
		invoice, err = service.VoidVatInvoice(ctx, actor, invoice.ID)
		if err != nil || invoice.Status != StatusVoided {
			t.Fatalf("invoice void: %#v %v", invoice, err)
		}
	})

	t.Run("concurrent audit serializes and invalid prior void rolls back", func(t *testing.T) {
		partyType := PartyEmployee
		posting := today
		billAttrs := &BillAttrs{
			BillNo: "BILL-" + suffix, BillKind: BillBankAcceptance,
			DueDate: future, FaceAmount: stringPointer("10"),
		}
		receive, err := service.CreateBillTransaction(ctx, actor, BillTransactionInput{
			TransactionType: TransactionReceive, OccurredOn: today,
			SubStart: 1, SubEnd: 1000, Amount: "10", PartyType: &partyType,
			PartyID: &employeeID, PostingDate: &posting, CompanyID: companyID,
			BankAccountID: bankAccountID, BillAttrs: billAttrs,
			BillAccountID: &billAccountID, SettleAccountID: &settleAccountID,
		})
		if err != nil {
			t.Fatal(err)
		}
		var successes atomic.Int64
		var wg sync.WaitGroup
		for range 2 {
			wg.Add(1)
			go func() {
				defer wg.Done()
				if _, auditErr := service.AuditBillTransaction(
					context.Background(), actor, receive.ID,
					AuditBillTransactionInput{PostingDate: &today},
				); auditErr == nil {
					successes.Add(1)
				}
			}()
		}
		wg.Wait()
		if successes.Load() != 1 {
			t.Fatalf("exactly one concurrent audit must commit, got %d", successes.Load())
		}
		receive, err = service.GetBillTransaction(ctx, actor, receive.ID)
		if err != nil {
			t.Fatal(err)
		}
		endorse, err := service.CreateBillTransaction(ctx, actor, BillTransactionInput{
			TransactionType: TransactionEndorse, OccurredOn: today,
			SubStart: 1, SubEnd: 500, Amount: "5", PartyType: &partyType,
			PartyID: &employeeID, PostingDate: &posting, CompanyID: companyID,
			BankAccountID: bankAccountID, BillID: &receive.BillID,
			BillAccountID: &billAccountID, SettleAccountID: &settleAccountID,
		})
		if err != nil {
			t.Fatal(err)
		}
		if _, err = service.AuditBillTransaction(ctx, actor, endorse.ID,
			AuditBillTransactionInput{PostingDate: &today}); err != nil {
			t.Fatal(err)
		}
		if _, err = service.VoidBillTransaction(ctx, actor, receive.ID); err == nil {
			t.Fatal("voiding consumed receive must fail replay and roll back")
		}
		receive, err = service.GetBillTransaction(ctx, actor, receive.ID)
		if err != nil || receive.Status != StatusAudited {
			t.Fatalf("failed void must preserve audited status: %#v %v", receive, err)
		}
		var liveEntries int
		if err = pool.QueryRow(ctx, `SELECT count(*) FROM acc_gl_entry
			WHERE voucher_type='acc.bill_transaction' AND voucher_id=$1
			AND NOT is_cancelled`, receive.ID).Scan(&liveEntries); err != nil {
			t.Fatal(err)
		}
		if liveEntries != 2 {
			t.Fatalf("failed void must roll back GL cancel, got %d", liveEntries)
		}
	})
}

func stringPointer(value string) *string { return &value }
