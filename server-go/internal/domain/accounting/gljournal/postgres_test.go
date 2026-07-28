package gljournal

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/platform/numbering"
	"github.com/z1coyan/synie/server/internal/platform/optional"
	"github.com/z1coyan/synie/server/internal/testutil"
)

type journalNumberer struct {
	value string
}

func (n journalNumberer) NextInTx(context.Context, pgx.Tx, numbering.NextInput) (string, error) {
	return n.value, nil
}

type journalFixture struct {
	pool               *pgxpool.Pool
	companyID, otherID uuid.UUID
	userID, currencyID uuid.UUID
	debitID, creditID  uuid.UUID
	customerID         uuid.UUID
	suffix             string
}

func TestPostgresJournalLifecycleScopeFilterAuditAndConcurrency(t *testing.T) {
	f := newJournalFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	actor := &authz.Actor{
		UserID: f.userID, Username: "journal-test", SuperAdmin: true,
		CompanyIDs: []uuid.UUID{f.companyID},
	}
	service := NewService(f.pool, journalNumberer{value: "记-" + f.suffix})
	date := time.Date(2026, 7, 26, 0, 0, 0, 0, time.UTC)
	journal, err := service.Create(ctx, actor, CreateInput{
		Date: date, CompanyID: f.companyID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if journal.Status != StatusDraft || journal.VoucherNo != "记-"+f.suffix ||
		journal.CreatedByID == nil || *journal.CreatedByID != f.userID ||
		journal.PostingDate != nil {
		t.Fatalf("created journal = %#v", journal)
	}
	partyType := "CUSTOMER"
	debit, credit := decimal.NewFromInt(125), decimal.NewFromInt(125)
	first, err := service.CreateLine(ctx, actor, CreateLineInput{
		JournalID: journal.ID, Idx: 1, AccountID: f.debitID, Debit: debit,
		PartyType: &partyType, PartyID: &f.customerID,
	})
	if err != nil {
		t.Fatal(err)
	}
	second, err := service.CreateLine(ctx, actor, CreateLineInput{
		JournalID: journal.ID, Idx: 2, AccountID: f.creditID, Credit: credit,
	})
	if err != nil {
		t.Fatal(err)
	}
	if first.CompanyID != f.companyID || first.CurrencyID == nil ||
		*first.CurrencyID != f.currencyID || first.PartyType == nil ||
		*first.PartyType != "CUSTOMER" {
		t.Fatalf("derived line = %#v", first)
	}
	if _, err := service.Audit(ctx, actor, journal.ID, nil); errorCode(err) != apierror.CodeValidation {
		t.Fatalf("missing posting date audit error = %#v", err)
	}
	zeroLine, err := service.CreateLine(ctx, actor, CreateLineInput{
		JournalID: journal.ID, Idx: 3, AccountID: f.creditID,
	})
	if err != nil {
		t.Fatal(err)
	}
	invalidPostingDate := date.AddDate(0, 0, 1)
	if _, err := service.Audit(ctx, actor, journal.ID, &invalidPostingDate); errorCode(err) != apierror.CodeValidation {
		t.Fatalf("zero line audit error = %#v", err)
	}
	var failedEntryCount int
	if err := f.pool.QueryRow(ctx,
		"SELECT count(*) FROM acc_gl_entry WHERE voucher_type='acc.gl_journal' AND voucher_id=$1",
		journal.ID,
	).Scan(&failedEntryCount); err != nil || failedEntryCount != 0 {
		t.Fatalf("failed audit entries=%d err=%v", failedEntryCount, err)
	}
	if err := service.DeleteLine(ctx, actor, zeroLine.ID); err != nil {
		t.Fatal(err)
	}
	list, err := service.List(ctx, actor, ListQuery{
		Limit: 20,
		Filter: map[string]json.RawMessage{
			"companyId": json.RawMessage(`{"kind":"fk","values":["` + f.companyID.String() + `"]}`),
			"status":    json.RawMessage(`{"kind":"enum","values":["DRAFT"]}`),
			"lines": json.RawMessage(`{"accountId":{"eq":"` + f.debitID.String() +
				`"},"debit":{"greaterThan":"0"}}`),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if list.Count != 1 || list.Results[0].ID != journal.ID ||
		!list.Results[0].DebitTotal.Equal(debit) ||
		!list.Results[0].CreditTotal.Equal(credit) {
		t.Fatalf("filtered list = %#v", list)
	}
	postingDate := date.AddDate(0, 0, 1)
	type auditResult struct {
		item Journal
		err  error
	}
	start := make(chan struct{})
	results := make(chan auditResult, 2)
	var wg sync.WaitGroup
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			item, auditErr := service.Audit(ctx, actor, journal.ID, &postingDate)
			results <- auditResult{item: item, err: auditErr}
		}()
	}
	close(start)
	wg.Wait()
	close(results)
	successes, conflicts := 0, 0
	for result := range results {
		if result.err == nil {
			successes++
			journal = result.item
		} else if errorCode(result.err) == apierror.CodeConflict {
			conflicts++
		} else {
			t.Fatalf("unexpected concurrent audit error: %v", result.err)
		}
	}
	if successes != 1 || conflicts != 1 || journal.Status != StatusAudited {
		t.Fatalf("concurrent audit successes=%d conflicts=%d journal=%#v", successes, conflicts, journal)
	}
	var entryCount int
	var totalDebit, totalCredit decimal.Decimal
	if err := f.pool.QueryRow(ctx, `
		SELECT count(*),sum(debit),sum(credit)
		FROM acc_gl_entry
		WHERE voucher_type='acc.gl_journal' AND voucher_id=$1
	`, journal.ID).Scan(&entryCount, &totalDebit, &totalCredit); err != nil {
		t.Fatal(err)
	}
	if entryCount != 2 || !totalDebit.Equal(debit) || !totalCredit.Equal(credit) {
		t.Fatalf("posted count=%d debit=%s credit=%s", entryCount, totalDebit, totalCredit)
	}
	if _, err := service.UpdateLine(ctx, actor, first.ID, UpdateLineInput{Idx: &first.Idx}); errorCode(err) != apierror.CodeConflict {
		t.Fatalf("audited line update error = %#v", err)
	}
	lockedRemark := "不可修改"
	if _, err := service.Update(ctx, actor, journal.ID, UpdateInput{Remarks: optional.Of(lockedRemark)}); errorCode(err) != apierror.CodeConflict {
		t.Fatalf("audited journal update error = %#v", err)
	}
	cancelled, err := service.Cancel(ctx, actor, journal.ID)
	if err != nil {
		t.Fatal(err)
	}
	if cancelled.Status != StatusCancelled {
		t.Fatalf("cancelled journal = %#v", cancelled)
	}
	var live int
	if err := f.pool.QueryRow(ctx, `
		SELECT count(*) FROM acc_gl_entry
		WHERE voucher_type='acc.gl_journal' AND voucher_id=$1 AND is_cancelled=false
	`, journal.ID).Scan(&live); err != nil {
		t.Fatal(err)
	}
	if live != 0 {
		t.Fatalf("cancel left %d live entries", live)
	}
	if _, err := service.Cancel(ctx, actor, journal.ID); errorCode(err) != apierror.CodeConflict {
		t.Fatalf("repeat cancel error = %#v", err)
	}
	var actions []string
	rows, err := f.pool.Query(ctx, `
		SELECT action_name FROM sys_audit_log
		WHERE company_id=$1 AND record_id=ANY($2::uuid[])
		ORDER BY inserted_at
	`, f.companyID, []uuid.UUID{journal.ID, first.ID, second.ID})
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var action string
		if err := rows.Scan(&action); err != nil {
			t.Fatal(err)
		}
		actions = append(actions, action)
	}
	rows.Close()
	for _, required := range []string{"create", "audit", "cancel"} {
		if !contains(actions, required) {
			t.Fatalf("audit actions %v missing %s", actions, required)
		}
	}
}

func TestPostgresJournalRejectsInvalidLineAndCompanyScope(t *testing.T) {
	f := newJournalFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	actor := &authz.Actor{
		UserID: f.userID, Username: "journal-scope",
		Permissions: map[string]struct{}{"acc.gl_journal:*": {}},
		CompanyIDs:  []uuid.UUID{f.companyID},
	}
	service := NewService(f.pool, journalNumberer{value: "SCOPE-" + f.suffix})
	date := time.Date(2026, 7, 26, 0, 0, 0, 0, time.UTC)
	journal, err := service.Create(ctx, actor, CreateInput{Date: date, CompanyID: f.companyID})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Cancel(ctx, actor, journal.ID); errorCode(err) != apierror.CodeConflict {
		t.Fatalf("draft cancel error = %#v", err)
	}
	remark := "草稿更新"
	journal, err = service.Update(ctx, actor, journal.ID, UpdateInput{Remarks: optional.Of(remark)})
	if err != nil || journal.Remarks == nil || *journal.Remarks != remark {
		t.Fatalf("draft update = %#v, err=%v", journal, err)
	}
	badParty := "CUSTOMER"
	missing := uuid.New()
	if _, err := service.CreateLine(ctx, actor, CreateLineInput{
		JournalID: journal.ID, Idx: 1, AccountID: f.debitID,
		PartyType: &badParty, PartyID: &missing,
	}); errorCode(err) != apierror.CodeValidation {
		t.Fatalf("missing party error = %#v", err)
	}
	both := decimal.NewFromInt(1)
	if _, err := service.CreateLine(ctx, actor, CreateLineInput{
		JournalID: journal.ID, Idx: 1, AccountID: f.debitID,
		Debit: both, Credit: both,
	}); errorCode(err) != apierror.CodeValidation {
		t.Fatalf("double-sided error = %#v", err)
	}
	line, err := service.CreateLine(ctx, actor, CreateLineInput{
		JournalID: journal.ID, Idx: 1, AccountID: f.debitID,
	})
	if err != nil {
		t.Fatal(err)
	}
	one := decimal.NewFromInt(1)
	line, err = service.UpdateLine(ctx, actor, line.ID, UpdateLineInput{Debit: &one})
	if err != nil || !line.Debit.Equal(one) {
		t.Fatalf("draft line update = %#v, err=%v", line, err)
	}
	if err := service.DeleteLine(ctx, actor, line.ID); err != nil {
		t.Fatal(err)
	}
	cascade, err := service.CreateLine(ctx, actor, CreateLineInput{
		JournalID: journal.ID, Idx: 2, AccountID: f.debitID,
	})
	if err != nil {
		t.Fatal(err)
	}
	outsider := &authz.Actor{
		Permissions: map[string]struct{}{"acc.gl_journal:*": {}},
		CompanyIDs:  []uuid.UUID{f.otherID},
	}
	if _, err := service.Get(ctx, outsider, journal.ID); errorCode(err) != apierror.CodeNotFound {
		t.Fatalf("cross-company get error = %#v", err)
	}
	if _, err := service.Get(ctx, &authz.Actor{}, journal.ID); errorCode(err) != apierror.CodeForbidden {
		t.Fatalf("missing permission error = %#v", err)
	}
	if _, err := service.List(ctx, &authz.Actor{
		Permissions: map[string]struct{}{"acc.gl_journal:read": {}},
	}, ListQuery{Limit: 20}); err != nil {
		t.Fatal(err)
	}
	if err := service.Delete(ctx, actor, journal.ID); err != nil {
		t.Fatal(err)
	}
	var cascadeCount int
	if err := f.pool.QueryRow(ctx,
		"SELECT count(*) FROM acc_gl_journal_line WHERE id=$1", cascade.ID,
	).Scan(&cascadeCount); err != nil || cascadeCount != 0 {
		t.Fatalf("cascade line count=%d err=%v", cascadeCount, err)
	}
}

func newJournalFixture(t *testing.T) journalFixture {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pool := testutil.NewPool(t, ctx)
	suffix := strings.ReplaceAll(uuid.NewString(), "-", "")[:12]
	f := journalFixture{
		pool: pool, companyID: uuid.New(), otherID: uuid.New(), userID: uuid.New(),
		currencyID: uuid.New(), debitID: uuid.New(), creditID: uuid.New(),
		customerID: uuid.New(), suffix: suffix,
	}
	batch := &pgx.Batch{}
	batch.Queue(`INSERT INTO bas_currency(id,name,iso_code,active) VALUES($1,$2,$3,true)`,
		f.currencyID, "凭证测试币-"+suffix, "J"+suffix)
	batch.Queue(`INSERT INTO bas_company(id,code,name,short_name,base_currency_id)
		VALUES($1,$2,$3,$3,$4),($5,$6,$7,$7,$4)`,
		f.companyID, "J"+suffix, "凭证测试公司-"+suffix, f.currencyID,
		f.otherID, "O"+suffix, "其他凭证测试公司-"+suffix)
	batch.Queue(`INSERT INTO sys_user(id,username,name,hashed_password,super_admin,all_companies)
		VALUES($1,$2,$3,'test',false,false)`,
		f.userID, "journal-"+suffix, "凭证测试用户-"+suffix)
	batch.Queue(`INSERT INTO bas_account
		(id,code,name,direction,is_group,active,role,company_id,currency_id)
		VALUES($1,$2,$3,'debit',false,true,'receivable',$7,$8),
		      ($4,$5,$6,'credit',false,true,NULL,$7,$8)`,
		f.debitID, "1122"+suffix, "应收账款-"+suffix,
		f.creditID, "6001"+suffix, "主营收入-"+suffix, f.companyID, f.currencyID)
	batch.Queue(`INSERT INTO sal_customers(id,code,name) VALUES($1,$2,$3)`,
		f.customerID, "C"+suffix, "凭证客户-"+suffix)
	results := pool.SendBatch(ctx, batch)
	if err := results.Close(); err != nil {
		pool.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM sys_audit_log WHERE company_id=$1", f.companyID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM acc_gl_entry WHERE company_id=$1", f.companyID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM acc_gl_journal_line WHERE company_id=$1", f.companyID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM acc_gl_journal WHERE company_id=$1", f.companyID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM bas_account WHERE company_id=$1", f.companyID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM sal_customers WHERE id=$1", f.customerID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM sys_user WHERE id=$1", f.userID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM bas_company WHERE id=ANY($1::uuid[])", []uuid.UUID{f.companyID, f.otherID})
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM bas_currency WHERE id=$1", f.currencyID)
		var residue int
		if err := pool.QueryRow(cleanupCtx, `
			SELECT
			  (SELECT count(*) FROM acc_gl_entry WHERE company_id=$1) +
			  (SELECT count(*) FROM acc_gl_journal_line WHERE company_id=$1) +
			  (SELECT count(*) FROM acc_gl_journal WHERE company_id=$1) +
			  (SELECT count(*) FROM sys_audit_log WHERE company_id=$1)
		`, f.companyID).Scan(&residue); err != nil {
			t.Errorf("verify cleanup: %v", err)
		} else if residue != 0 {
			t.Errorf("journal fixture residue = %d", residue)
		}
		pool.Close()
	})
	return f
}

func errorCode(err error) apierror.Code {
	var target *apierror.Error
	if errors.As(err, &target) {
		return target.Code
	}
	return ""
}

func contains(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}
