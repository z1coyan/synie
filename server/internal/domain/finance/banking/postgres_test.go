package banking

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
	"github.com/z1coyan/synie/server/internal/domain/accounting/gljournal"
	"github.com/z1coyan/synie/server/internal/engines/gl"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/authz"
	fileplatform "github.com/z1coyan/synie/server/internal/platform/files"
	"github.com/z1coyan/synie/server/internal/platform/numbering"
)

type bankingTestFile struct {
	file    fileplatform.File
	content []byte
}

type bankingTestFileReader map[uuid.UUID]bankingTestFile

func (reader bankingTestFileReader) ReadStoredFile(
	_ context.Context, id uuid.UUID,
) (fileplatform.File, []byte, error) {
	value, ok := reader[id]
	if !ok {
		return fileplatform.File{}, nil, errors.New("not found")
	}
	return value.file, append([]byte(nil), value.content...), nil
}

type fixedBankingNumberer struct{ value string }

func (numberer fixedBankingNumberer) NextInTx(
	context.Context, pgx.Tx, numbering.NextInput,
) (string, error) {
	return numberer.value, nil
}

type postThenFailLedger struct{}

func (postThenFailLedger) Post(
	ctx context.Context, tx pgx.Tx, voucher gl.Voucher, entries []gl.Entry,
	options ...gl.PostOptions,
) error {
	if err := gl.Post(ctx, tx, voucher, entries, options...); err != nil {
		return err
	}
	return errors.New("forced failure after GL writes")
}

type bankingFixture struct {
	pool                           *pgxpool.Pool
	company, otherCompany          uuid.UUID
	currency, user                 uuid.UUID
	bankLedger, counter, alternate uuid.UUID
	suffix                         string
	actor                          *authz.Actor
}

func TestPostgresBankAccountCRUDPermissionAndCompanyScope(t *testing.T) {
	f := newBankingFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	service := NewService(f.pool, Dependencies{})

	account, err := service.CreateBankAccount(ctx, f.actor, BankAccountCreateInput{
		Alias: "基本户-" + f.suffix, BankName: "测试银行", HolderName: "测试公司",
		AccountNo: "6222" + f.suffix, CompanyID: f.company,
		CurrencyID: f.currency, AccountID: &f.bankLedger,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !account.Active || account.CompanyID != f.company || account.AccountID == nil ||
		*account.AccountID != f.bankLedger {
		t.Fatalf("created account = %#v", account)
	}
	result, err := service.QueryBankAccounts(ctx, f.actor, ListQuery{
		Sort: &filterbuild.Sort{Column: "alias", Direction: "ascending"},
		Filter: map[string]json.RawMessage{
			"alias": json.RawMessage(`{"kind":"text","op":"contains","value":"基本户-"}`),
		},
	})
	if err != nil || result.Count != 1 || result.Results[0].ID != account.ID {
		t.Fatalf("query = %#v err=%v", result, err)
	}
	otherActor := *f.actor
	otherActor.CompanyIDs = []uuid.UUID{f.otherCompany}
	if _, err := service.GetBankAccount(ctx, &otherActor, account.ID); codeOf(err) != apierror.CodeNotFound {
		t.Fatalf("company scope get = %v", err)
	}
	noPermission := &authz.Actor{CompanyIDs: []uuid.UUID{f.company}}
	if _, err := service.GetBankAccount(ctx, noPermission, account.ID); codeOf(err) != apierror.CodeForbidden {
		t.Fatalf("permission must precede scope = %v", err)
	}
	newAlias := "更新户-" + f.suffix
	account, err = service.UpdateBankAccount(ctx, f.actor, account.ID, BankAccountUpdateInput{
		Alias: &newAlias,
	})
	if err != nil || account.Alias != newAlias {
		t.Fatalf("update = %#v err=%v", account, err)
	}
	if err := service.DeleteBankAccount(ctx, f.actor, account.ID); err != nil {
		t.Fatal(err)
	}
}

func TestPostgresTransactionAndTemplateRules(t *testing.T) {
	f := newBankingFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	service := NewService(f.pool, Dependencies{})
	account, err := service.CreateBankAccount(ctx, f.actor, BankAccountCreateInput{
		Alias: "导入户-" + f.suffix, BankName: "测试银行", HolderName: "测试公司",
		AccountNo: "9558" + f.suffix, CompanyID: f.company,
		CurrencyID: f.currency, AccountID: &f.bankLedger,
	})
	if err != nil {
		t.Fatal(err)
	}
	amount := decimal.RequireFromString("100.25")
	transaction, err := service.CreateBankTransaction(ctx, f.actor, BankTransactionCreateInput{
		OccurredAt: time.Date(2026, 7, 26, 3, 4, 5, 0, time.UTC),
		Income:     &amount, CompanyID: f.company, BankAccountID: account.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if transaction.UnreconciledAmount.String() != "100.25" ||
		transaction.ReconcileStatus != ReconcileUnreconciled {
		t.Fatalf("transaction projection = %#v", transaction)
	}
	if _, err := service.CreateBankTransaction(ctx, f.actor, BankTransactionCreateInput{
		OccurredAt: time.Now(), Income: &amount, Expense: &amount,
		CompanyID: f.company, BankAccountID: account.ID,
	}); codeOf(err) != apierror.CodeValidation {
		t.Fatalf("two-sided amount = %v", err)
	}
	template, err := service.CreateBankImportTemplate(ctx, f.actor, BankImportTemplateCreateInput{
		Name: "银行模板-" + f.suffix, StartRow: 2,
		DatetimeCol: strptr(" aa "), DatetimeFormat: strptr("YMD_DASH_HMS"),
		AmountCol: strptr("d"), CompanyID: f.company, BankAccountID: account.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if template.DatetimeCol == nil || *template.DatetimeCol != "AA" ||
		template.AmountCol == nil || *template.AmountCol != "D" {
		t.Fatalf("normalized template = %#v", template)
	}
	if _, err := service.CreateBankImportTemplate(ctx, f.actor, BankImportTemplateCreateInput{
		Name: "非法模板-" + f.suffix, StartRow: 1,
		DatetimeCol: strptr("A"), DatetimeFormat: strptr("YMD_DASH_HMS"),
		IncomeCol: strptr("B"), AmountCol: strptr("C"),
		CompanyID: f.company, BankAccountID: account.ID,
	}); codeOf(err) != apierror.CodeValidation {
		t.Fatalf("mixed amount mode = %v", err)
	}
	if err := service.DeleteBankTransaction(ctx, f.actor, transaction.ID); err != nil {
		t.Fatal(err)
	}
	if err := service.DeleteBankImportTemplate(ctx, f.actor, template.ID); err != nil {
		t.Fatal(err)
	}
}

func TestPostgresBankImportLifecycleAndParentLock(t *testing.T) {
	f := newBankingFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	account, err := NewService(f.pool, Dependencies{}).CreateBankAccount(
		ctx, f.actor, BankAccountCreateInput{
			Alias: "导入执行户-" + f.suffix, BankName: "测试银行", HolderName: "测试公司",
			AccountNo: "6210" + f.suffix, CompanyID: f.company,
			CurrencyID: f.currency, AccountID: &f.bankLedger,
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	template, err := NewService(f.pool, Dependencies{}).CreateBankImportTemplate(
		ctx, f.actor, BankImportTemplateCreateInput{
			Name: "执行模板-" + f.suffix, StartRow: 2,
			DatetimeCol: strptr("A"), DatetimeFormat: strptr("YMD_DASH_HMS"),
			AmountCol: strptr("B"), SummaryCol: strptr("C"),
			CompanyID: f.company, BankAccountID: account.ID,
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	fileID := uuid.New()
	content := testXLSX(t, map[string]string{
		"A1": "时间", "B1": "金额", "C1": "摘要",
		"A2": "2026-07-01 10:30:00", "B2": "100", "C2": "第一行",
		"A3": "2026-07-02 09:00:00", "B3": "-25", "C3": "第二行",
	})
	reader := bankingTestFileReader{
		fileID: {
			file: fileplatform.File{
				ID: fileID, Filename: "bank.xlsx", SHA256: "sha-" + f.suffix,
			},
			content: content,
		},
	}
	if _, err := f.pool.Exec(ctx, `INSERT INTO sys_file(
		id,storage,key,filename,size,sha256,uploaded_by_id)
		VALUES($1,'local',$2,'bank.xlsx',$3,$4,$5)`,
		fileID, "bank-"+f.suffix, len(content), "sha-"+f.suffix, f.user); err != nil {
		t.Fatal(err)
	}
	service := NewService(f.pool, Dependencies{Files: reader})
	batch, err := service.CreateBankImport(ctx, f.actor, BankImportCreateInput{
		CompanyID: f.company, BankAccountID: account.ID,
		TemplateID: template.ID, FileID: fileID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if batch.Status != ImportParsed || batch.ItemCount != 2 || batch.ErrorCount != 0 {
		t.Fatalf("batch = %#v", batch)
	}
	if _, err := service.CreateBankImport(ctx, f.actor, BankImportCreateInput{
		CompanyID: f.company, BankAccountID: account.ID,
		TemplateID: template.ID, FileID: fileID,
	}); codeOf(err) != apierror.CodeValidation {
		t.Fatalf("duplicate = %v", err)
	}
	items, err := service.QueryBankImportItems(ctx, f.actor, ListQuery{
		Filter: map[string]json.RawMessage{
			"importId": json.RawMessage(`{"kind":"fk","values":["` + batch.ID.String() + `"]}`),
		},
	})
	if err != nil || items.Count != 2 {
		t.Fatalf("items = %#v err=%v", items, err)
	}

	lockTx, err := f.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := lockTx.Exec(ctx, `SELECT 1 FROM acc_bank_import WHERE id=$1 FOR UPDATE`, batch.ID); err != nil {
		t.Fatal(err)
	}
	blockedCtx, blockedCancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	_, blockedErr := service.UpdateBankImportItem(
		blockedCtx, f.actor, items.Results[0].ID, BankImportItemUpdateInput{
			Summary: Optional[string]{Set: true, Value: strptr("被阻塞")},
		},
	)
	blockedCancel()
	if blockedErr == nil || !errors.Is(blockedErr, context.DeadlineExceeded) {
		t.Fatalf("item update must wait for parent lock: %v", blockedErr)
	}
	if err := lockTx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	updated, err := service.UpdateBankImportItem(
		ctx, f.actor, items.Results[0].ID, BankImportItemUpdateInput{
			Summary: Optional[string]{Set: true, Value: strptr("已修订")},
		},
	)
	if err != nil || updated.Summary == nil || *updated.Summary != "已修订" {
		t.Fatalf("updated = %#v err=%v", updated, err)
	}
	batch, err = service.ImportBankImport(ctx, f.actor, batch.ID)
	if err != nil {
		t.Fatal(err)
	}
	if batch.Status != ImportImported || batch.ImportedAt == nil || batch.ImportedByID == nil {
		t.Fatalf("imported = %#v", batch)
	}
	items, err = service.QueryBankImportItems(ctx, f.actor, ListQuery{
		Filter: map[string]json.RawMessage{
			"importId": json.RawMessage(`{"kind":"fk","values":["` + batch.ID.String() + `"]}`),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range items.Results {
		if item.TransactionID == nil {
			t.Fatalf("unlinked item = %#v", item)
		}
	}
	if err := service.DeleteBankImport(ctx, f.actor, batch.ID); codeOf(err) != apierror.CodeConflict {
		t.Fatalf("delete imported = %v", err)
	}

	badFileID := uuid.New()
	reader[badFileID] = bankingTestFile{
		file: fileplatform.File{
			ID: badFileID, Filename: "fake.xls", SHA256: "bad-" + f.suffix,
		},
		content: []byte("<html>not excel</html>"),
	}
	if _, err := f.pool.Exec(ctx, `INSERT INTO sys_file(
		id,storage,key,filename,size,sha256,uploaded_by_id)
		VALUES($1,'local',$2,'fake.xls',22,$3,$4)`,
		badFileID, "bad-"+f.suffix, "bad-"+f.suffix, f.user); err != nil {
		t.Fatal(err)
	}
	failed, err := service.CreateBankImport(ctx, f.actor, BankImportCreateInput{
		CompanyID: f.company, BankAccountID: account.ID,
		TemplateID: template.ID, FileID: badFileID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if failed.Status != ImportFailed || failed.Error == nil || failed.ItemCount != 0 {
		t.Fatalf("failed batch = %#v", failed)
	}
	if err := service.DeleteBankImport(ctx, f.actor, failed.ID); err != nil {
		t.Fatal(err)
	}
}

func TestPostgresReconciliationCapacityGuardsAndQuickAtomicity(t *testing.T) {
	f := newBankingFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	baseService := NewService(f.pool, Dependencies{})
	account, err := baseService.CreateBankAccount(ctx, f.actor, BankAccountCreateInput{
		Alias: "对账户-" + f.suffix, BankName: "测试银行", HolderName: "测试公司",
		AccountNo: "6230" + f.suffix, CompanyID: f.company,
		CurrencyID: f.currency, AccountID: &f.bankLedger,
	})
	if err != nil {
		t.Fatal(err)
	}
	hundred := decimal.NewFromInt(100)
	transaction, err := baseService.CreateBankTransaction(
		ctx, f.actor, BankTransactionCreateInput{
			OccurredAt: time.Date(2026, 7, 26, 1, 0, 0, 0, time.UTC),
			Income:     &hundred, CompanyID: f.company, BankAccountID: account.ID,
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	journalID := createAuditedBankingJournal(
		t, ctx, f, "R1-"+f.suffix, f.bankLedger, hundred, true,
	)
	remaining, err := baseService.RemainingBankReconciliation(
		ctx, f.actor, transaction.ID, journalID,
	)
	if err != nil || !remaining.Equal(hundred) {
		t.Fatalf("initial remaining = %s err=%v", remaining, err)
	}
	sixty := decimal.NewFromInt(60)
	reconciliation, err := baseService.CreateBankReconciliation(
		ctx, f.actor, BankReconciliationCreateInput{
			BankTransactionID: transaction.ID, JournalID: journalID, Amount: sixty,
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	transaction, err = baseService.GetBankTransaction(ctx, f.actor, transaction.ID)
	if err != nil {
		t.Fatal(err)
	}
	if transaction.ReconcileStatus != ReconcilePartial ||
		!transaction.ReconciledAmount.Equal(sixty) ||
		!transaction.UnreconciledAmount.Equal(decimal.NewFromInt(40)) {
		t.Fatalf("projection = %#v", transaction)
	}
	remaining, err = baseService.RemainingBankReconciliation(
		ctx, f.actor, transaction.ID, journalID,
	)
	if err != nil || !remaining.Equal(decimal.NewFromInt(40)) {
		t.Fatalf("remaining = %s err=%v", remaining, err)
	}
	fifty := decimal.NewFromInt(50)
	if _, err := baseService.UpdateBankTransaction(
		ctx, f.actor, transaction.ID, BankTransactionUpdateInput{
			Income: Optional[decimal.Decimal]{Set: true, Value: &fifty},
		},
	); codeOf(err) != apierror.CodeValidation {
		t.Fatalf("shrink guard = %v", err)
	}
	if _, err := baseService.UpdateBankTransaction(
		ctx, f.actor, transaction.ID, BankTransactionUpdateInput{
			Income:  Optional[decimal.Decimal]{Set: true},
			Expense: Optional[decimal.Decimal]{Set: true, Value: &hundred},
		},
	); codeOf(err) != apierror.CodeConflict {
		t.Fatalf("side guard = %v", err)
	}
	if _, err := baseService.UpdateBankAccount(
		ctx, f.actor, account.ID, BankAccountUpdateInput{
			AccountID: Optional[uuid.UUID]{Set: true, Value: &f.alternate},
		},
	); codeOf(err) != apierror.CodeConflict {
		t.Fatalf("ledger rebind guard = %v", err)
	}
	if err := baseService.DeleteBankTransaction(
		ctx, f.actor, transaction.ID,
	); codeOf(err) != apierror.CodeConflict {
		t.Fatalf("transaction delete guard = %v", err)
	}
	if _, err := gljournal.NewService(f.pool).Cancel(
		ctx, f.actor, journalID,
	); codeOf(err) != apierror.CodeConflict {
		t.Fatalf("journal cancel guard = %v", err)
	}
	if err := baseService.DeleteBankReconciliation(
		ctx, f.actor, reconciliation.ID,
	); err != nil {
		t.Fatal(err)
	}
	transaction, err = baseService.GetBankTransaction(ctx, f.actor, transaction.ID)
	if err != nil || transaction.ReconcileStatus != ReconcileUnreconciled ||
		!transaction.ReconciledAmount.IsZero() ||
		!transaction.UnreconciledAmount.Equal(hundred) {
		t.Fatalf("projection after delete = %#v err=%v", transaction, err)
	}

	marker := "rollback-marker-" + f.suffix
	rollbackService := NewService(f.pool, Dependencies{
		Numberer: fixedBankingNumberer{value: "QF-" + f.suffix},
		Ledger:   postThenFailLedger{},
	})
	thirty := decimal.NewFromInt(30)
	if _, err := rollbackService.QuickCreateBankReconciliation(
		ctx, f.actor, QuickReconciliationInput{
			BankTransactionID: transaction.ID, CounterAccountID: f.counter,
			Amount: thirty, Summary: &marker,
			PostingDate: time.Date(2026, 7, 26, 0, 0, 0, 0, time.UTC),
		},
	); err == nil {
		t.Fatal("expected forced GL failure")
	}
	var journalCount, lineCount, entryCount, reconciliationCount int
	if err := f.pool.QueryRow(ctx, `
		SELECT
		  (SELECT count(*) FROM acc_gl_journal WHERE remarks=$1),
		  (SELECT count(*) FROM acc_gl_journal_line l
		   JOIN acc_gl_journal j ON j.id=l.journal_id WHERE j.remarks=$1),
		  (SELECT count(*) FROM acc_gl_entry e
		   JOIN acc_gl_journal j ON j.id=e.voucher_id
		   WHERE e.voucher_type='acc.gl_journal' AND j.remarks=$1),
		  (SELECT count(*) FROM acc_bank_reconciliation
		   WHERE bank_transaction_id=$2)`,
		marker, transaction.ID).Scan(
		&journalCount, &lineCount, &entryCount, &reconciliationCount,
	); err != nil {
		t.Fatal(err)
	}
	transaction, err = baseService.GetBankTransaction(ctx, f.actor, transaction.ID)
	if err != nil || journalCount != 0 || lineCount != 0 || entryCount != 0 ||
		reconciliationCount != 0 || !transaction.ReconciledAmount.IsZero() {
		t.Fatalf("quick rollback journal=%d lines=%d entries=%d rec=%d txn=%#v err=%v",
			journalCount, lineCount, entryCount, reconciliationCount, transaction, err)
	}

	quickMarker := "quick-success-" + f.suffix
	quickService := NewService(f.pool, Dependencies{
		Numberer: fixedBankingNumberer{value: "QS-" + f.suffix},
	})
	quick, err := quickService.QuickCreateBankReconciliation(
		ctx, f.actor, QuickReconciliationInput{
			BankTransactionID: transaction.ID, CounterAccountID: f.counter,
			Amount: thirty, Summary: &quickMarker,
			PostingDate: time.Date(2026, 7, 26, 0, 0, 0, 0, time.UTC),
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	var status string
	if err := f.pool.QueryRow(ctx, `
		SELECT j.status,
		  (SELECT count(*) FROM acc_gl_journal_line WHERE journal_id=j.id),
		  (SELECT count(*) FROM acc_gl_entry
		   WHERE voucher_type='acc.gl_journal' AND voucher_id=j.id)
		FROM acc_gl_journal j WHERE j.id=$1`, quick.JournalID).
		Scan(&status, &lineCount, &entryCount); err != nil {
		t.Fatal(err)
	}
	transaction, err = baseService.GetBankTransaction(ctx, f.actor, transaction.ID)
	if err != nil || status != "audited" || lineCount != 2 || entryCount != 2 ||
		!transaction.ReconciledAmount.Equal(thirty) {
		t.Fatalf("quick status=%s lines=%d entries=%d txn=%#v err=%v",
			status, lineCount, entryCount, transaction, err)
	}
}

func TestPostgresConcurrentReconciliationSerializesCapacity(t *testing.T) {
	f := newBankingFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	service := NewService(f.pool, Dependencies{})
	account, err := service.CreateBankAccount(ctx, f.actor, BankAccountCreateInput{
		Alias: "并发户-" + f.suffix, BankName: "测试银行", HolderName: "测试公司",
		AccountNo: "6240" + f.suffix, CompanyID: f.company,
		CurrencyID: f.currency, AccountID: &f.bankLedger,
	})
	if err != nil {
		t.Fatal(err)
	}
	hundred := decimal.NewFromInt(100)
	transaction, err := service.CreateBankTransaction(
		ctx, f.actor, BankTransactionCreateInput{
			OccurredAt: time.Now().UTC(), Income: &hundred,
			CompanyID: f.company, BankAccountID: account.ID,
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	journals := []uuid.UUID{
		createAuditedBankingJournal(t, ctx, f, "C1-"+f.suffix, f.bankLedger, hundred, true),
		createAuditedBankingJournal(t, ctx, f, "C2-"+f.suffix, f.bankLedger, hundred, true),
	}
	start := make(chan struct{})
	errorsCh := make(chan error, 2)
	seventy := decimal.NewFromInt(70)
	for _, journalID := range journals {
		go func(journalID uuid.UUID) {
			<-start
			_, createErr := service.CreateBankReconciliation(
				ctx, f.actor, BankReconciliationCreateInput{
					BankTransactionID: transaction.ID,
					JournalID:         journalID, Amount: seventy,
				},
			)
			errorsCh <- createErr
		}(journalID)
	}
	close(start)
	successes := 0
	failures := 0
	for range 2 {
		if createErr := <-errorsCh; createErr == nil {
			successes++
		} else if codeOf(createErr) == apierror.CodeValidation {
			failures++
		} else {
			t.Fatalf("unexpected concurrent error: %v", createErr)
		}
	}
	if successes != 1 || failures != 1 {
		t.Fatalf("successes=%d failures=%d", successes, failures)
	}
	transaction, err = service.GetBankTransaction(ctx, f.actor, transaction.ID)
	if err != nil || !transaction.ReconciledAmount.Equal(seventy) ||
		!transaction.UnreconciledAmount.Equal(decimal.NewFromInt(30)) {
		t.Fatalf("concurrent projection = %#v err=%v", transaction, err)
	}
}

func createAuditedBankingJournal(
	t *testing.T, ctx context.Context, f bankingFixture, no string,
	accountID uuid.UUID, amount decimal.Decimal, debit bool,
) uuid.UUID {
	t.Helper()
	id := uuid.New()
	debitAmount, creditAmount := decimal.Zero, amount
	if debit {
		debitAmount, creditAmount = amount, decimal.Zero
	}
	batch := &pgx.Batch{}
	batch.Queue(`INSERT INTO acc_gl_journal(
		id,voucher_no,date,posting_date,status,company_id,created_by_id,submitted_by_id)
		VALUES($1,$2,'2026-07-26','2026-07-26','audited',$3,$4,$4)`,
		id, no, f.company, f.user)
	batch.Queue(`INSERT INTO acc_gl_journal_line(
		id,idx,debit,credit,journal_id,company_id,account_id,currency_id)
		VALUES($1,1,$2,$3,$4,$5,$6,$7)`,
		uuid.New(), debitAmount, creditAmount, id, f.company, accountID, f.currency)
	results := f.pool.SendBatch(ctx, batch)
	if err := results.Close(); err != nil {
		t.Fatal(err)
	}
	return id
}

func newBankingFixture(t *testing.T) bankingFixture {
	t.Helper()
	databaseURL := os.Getenv("SYNIE_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("set SYNIE_TEST_DATABASE_URL to run the real PostgreSQL tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	suffix := strings.ReplaceAll(uuid.NewString(), "-", "")[:10]
	f := bankingFixture{
		pool: pool, company: uuid.New(), otherCompany: uuid.New(),
		currency: uuid.New(), user: uuid.New(), bankLedger: uuid.New(),
		counter: uuid.New(), alternate: uuid.New(), suffix: suffix,
	}
	batch := &pgx.Batch{}
	batch.Queue(`INSERT INTO bas_currency(id,name,iso_code,active) VALUES($1,$2,$3,true)`,
		f.currency, "银行测试币-"+suffix, "B"+suffix)
	batch.Queue(`INSERT INTO bas_company(id,code,name,short_name,base_currency_id)
		VALUES($1,$2,$3,$3,$4),($5,$6,$7,$7,$4)`,
		f.company, "B"+suffix, "银行测试公司-"+suffix, f.currency,
		f.otherCompany, "O"+suffix, "其他银行测试公司-"+suffix)
	batch.Queue(`INSERT INTO sys_user(id,username,name,hashed_password,super_admin,all_companies)
		VALUES($1,$2,$3,'test',false,false)`,
		f.user, "banking-"+suffix, "银行测试用户-"+suffix)
	batch.Queue(`INSERT INTO bas_account
		(id,code,name,direction,is_group,active,company_id,currency_id)
		VALUES($1,$2,$3,'debit',false,true,$10,$11),
		      ($4,$5,$6,'debit',false,true,$10,$11),
		      ($7,$8,$9,'debit',false,true,$10,$11)`,
		f.bankLedger, "1002"+suffix, "银行存款-"+suffix,
		f.counter, "6001"+suffix, "对方科目-"+suffix,
		f.alternate, "1003"+suffix, "备用银行科目-"+suffix,
		f.company, f.currency)
	results := pool.SendBatch(ctx, batch)
	if err := results.Close(); err != nil {
		pool.Close()
		t.Fatal(err)
	}
	f.actor = &authz.Actor{
		UserID: f.user, Username: "banking-" + suffix,
		CompanyIDs: []uuid.UUID{f.company},
		Permissions: map[string]struct{}{
			"acc.bank_account:read":           {},
			"acc.bank_account:create":         {},
			"acc.bank_account:update":         {},
			"acc.bank_account:delete":         {},
			"acc.bank_transaction:read":       {},
			"acc.bank_transaction:create":     {},
			"acc.bank_transaction:update":     {},
			"acc.bank_transaction:delete":     {},
			"acc.bank_transaction:import":     {},
			"acc.bank_transaction:reconcile":  {},
			"acc.bank_import_template:read":   {},
			"acc.bank_import_template:create": {},
			"acc.bank_import_template:update": {},
			"acc.bank_import_template:delete": {},
			"acc.gl_journal:read":             {},
			"acc.gl_journal:create":           {},
			"acc.gl_journal:audit":            {},
			"acc.gl_journal:cancel":           {},
			"sys.file:read":                   {},
		},
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cleanupCancel()
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM sys_audit_log WHERE company_id=$1`, f.company)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM acc_gl_entry WHERE company_id=$1`, f.company)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM acc_bank_reconciliation WHERE company_id=$1`, f.company)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM acc_gl_journal_line WHERE company_id=$1`, f.company)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM acc_gl_journal WHERE company_id=$1`, f.company)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM acc_bank_import_item WHERE company_id=$1`, f.company)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM acc_bank_import WHERE company_id=$1`, f.company)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM acc_bank_import_template WHERE company_id=$1`, f.company)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM acc_bank_transaction WHERE company_id=$1`, f.company)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM acc_bank_account WHERE company_id=$1`, f.company)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM bas_account WHERE company_id=$1`, f.company)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM sys_file WHERE uploaded_by_id=$1`, f.user)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM sys_user WHERE id=$1`, f.user)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM bas_company WHERE id=ANY($1::uuid[])`,
			[]uuid.UUID{f.company, f.otherCompany})
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM bas_currency WHERE id=$1`, f.currency)
		var residue int
		if err := pool.QueryRow(cleanupCtx, `
			SELECT (SELECT count(*) FROM acc_bank_account WHERE company_id=$1) +
			       (SELECT count(*) FROM acc_bank_transaction WHERE company_id=$1) +
			       (SELECT count(*) FROM acc_bank_import WHERE company_id=$1) +
			       (SELECT count(*) FROM acc_bank_reconciliation WHERE company_id=$1) +
			       (SELECT count(*) FROM sys_audit_log WHERE company_id=$1)`,
			f.company).Scan(&residue); err != nil {
			t.Errorf("verify cleanup: %v", err)
		} else if residue != 0 {
			t.Errorf("banking fixture residue = %d", residue)
		}
		pool.Close()
	})
	return f
}

func codeOf(err error) apierror.Code {
	var target *apierror.Error
	if errors.As(err, &target) {
		return target.Code
	}
	return ""
}

func strptr(value string) *string { return &value }
