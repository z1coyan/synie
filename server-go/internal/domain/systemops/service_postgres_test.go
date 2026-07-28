package systemops

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/testutil"
)

func TestPostgresSystemOperationsPolicyStateAndTransactions(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	pool := testutil.NewPool(t, ctx)

	suffix := strings.ReplaceAll(uuid.NewString(), "-", "")[:10]
	currencyID, companyA, companyB := uuid.New(), uuid.New(), uuid.New()
	customerID, userA, userB := uuid.New(), uuid.New(), uuid.New()
	debitAccountID, creditAccountID := uuid.New(), uuid.New()
	openSourceID := uuid.New()
	auditGlobal, auditA, auditB := uuid.New(), uuid.New(), uuid.New()
	_, err := pool.Exec(ctx, `INSERT INTO bas_currency(id,name,iso_code,symbol,active)
		VALUES($1,$2,$3,'$',true)`, currencyID, "测试币-"+suffix, "X"+suffix[:2])
	if err == nil {
		_, err = pool.Exec(ctx, `INSERT INTO bas_company(id,code,name,short_name,base_currency_id)
		  VALUES($1,$2,$3,$4,$9),($5,$6,$7,$8,$9)`,
			companyA, "COA-"+suffix, "公司A-"+suffix, "A-"+suffix,
			companyB, "COB-"+suffix, "公司B-"+suffix, "B-"+suffix, currencyID)
	}
	if err == nil {
		_, err = pool.Exec(ctx, `INSERT INTO sal_customers(id,code,name) VALUES($1,$2,$3)`,
			customerID, "CUS-"+suffix, "客户-"+suffix)
	}
	if err == nil {
		_, err = pool.Exec(ctx, `INSERT INTO sys_user(id,username,name,hashed_password)
		  VALUES($1,$2,'用户A','test'),($3,$4,'用户B','test')`,
			userA, "sysops-a-"+suffix, userB, "sysops-b-"+suffix)
	}
	if err == nil {
		_, err = pool.Exec(ctx, `INSERT INTO sys_audit_log(id,resource,record_id,record_label,action_type,action_name,company_id,changes)
		  VALUES
		  ($1,'sys_pg_global',$4,'AUD-global','update','update',NULL,'{"name":{"to":"g"}}'),
		  ($2,'sys_pg_company',$5,'AUD-a','create','create',$7,'{"name":{"to":"a"}}'),
		  ($3,'sys_pg_company',$6,'AUD-b','destroy','destroy',$8,'{"name":{"from":"b"}}')`,
			auditGlobal, auditA, auditB, uuid.New(), uuid.New(), uuid.New(), companyA, companyB)
	}
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cleanupCancel()
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM sys_todo WHERE company_id=ANY($1::uuid[])`, []uuid.UUID{companyA, companyB})
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM acc_vat_invoice WHERE company_id=ANY($1::uuid[])`, []uuid.UUID{companyA, companyB})
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM sal_reconciliation WHERE id=$1`, openSourceID)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM bas_account WHERE id=ANY($1::uuid[])`, []uuid.UUID{debitAccountID, creditAccountID})
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM sys_audit_log WHERE id=ANY($1::uuid[])`, []uuid.UUID{auditGlobal, auditA, auditB})
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM sys_user WHERE id=ANY($1::uuid[])`, []uuid.UUID{userA, userB})
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM sal_customers WHERE id=$1`, customerID)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM bas_company WHERE id=ANY($1::uuid[])`, []uuid.UUID{companyA, companyB})
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM bas_currency WHERE id=$1`, currencyID)
	})

	service := NewService(pool)
	auditActor := actorFor(userA, companyA, "sys.audit_log:read")
	t.Run("audit permission company scope search sort and get", func(t *testing.T) {
		result, queryErr := service.QueryAuditLogs(ctx, auditActor, ListQuery{
			Limit: 10, Search: "AUD",
		})
		if queryErr != nil {
			t.Fatal(queryErr)
		}
		if result.Count != 2 || len(result.Results) != 2 {
			t.Fatalf("audit result = %#v", result)
		}
		if _, queryErr = service.GetAuditLog(ctx, auditActor, auditA); queryErr != nil {
			t.Fatal(queryErr)
		}
		if _, queryErr = service.GetAuditLog(ctx, auditActor, auditB); errorCode(queryErr) != apierror.CodeNotFound {
			t.Fatalf("cross-company get = %#v", queryErr)
		}
		filtered, queryErr := service.QueryAuditLogs(ctx, auditActor, ListQuery{
			Limit: 10,
			Filter: map[string]json.RawMessage{
				"resource": json.RawMessage(`{"kind":"text","op":"eq","value":"sys_pg_company"}`),
			},
		})
		if queryErr != nil || filtered.Count != 1 || filtered.Results[0].ID != auditA {
			t.Fatalf("filtered = %#v, %v", filtered, queryErr)
		}
	})

	open := OpenTodoInput{
		Type: TodoTypeIssueInvoice, SourceType: SourceSalesReconciliation,
		SourceID: openSourceID, SourceNo: "SR-" + suffix, CompanyID: companyA,
		PartyType: "customer", PartyID: customerID, Amount: decimal.RequireFromString("300.00"),
		CreatedByID: &userA,
	}
	var todo Todo
	t.Run("open participates in caller rollback and commit", func(t *testing.T) {
		tx, beginErr := pool.Begin(ctx)
		if beginErr != nil {
			t.Fatal(beginErr)
		}
		rolled := open
		rolled.SourceID, rolled.SourceNo = uuid.New(), "ROLLBACK-"+suffix
		created, openErr := service.OpenTodo(ctx, tx, rolled)
		if openErr != nil {
			t.Fatal(openErr)
		}
		if rollbackErr := tx.Rollback(ctx); rollbackErr != nil {
			t.Fatal(rollbackErr)
		}
		var exists bool
		if queryErr := pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM sys_todo WHERE id=$1)`, created.ID).Scan(&exists); queryErr != nil || exists {
			t.Fatalf("rollback exists=%v err=%v", exists, queryErr)
		}

		tx, beginErr = pool.Begin(ctx)
		if beginErr != nil {
			t.Fatal(beginErr)
		}
		todo, openErr = service.OpenTodo(ctx, tx, open)
		if openErr != nil {
			_ = tx.Rollback(ctx)
			t.Fatal(openErr)
		}
		if commitErr := tx.Commit(ctx); commitErr != nil {
			t.Fatal(commitErr)
		}
	})

	todoActorA := actorFor(userA, companyA, "acc.vat_invoice:create", "acc.vat_invoice:read")
	todoActorB := actorFor(userB, companyA, "acc.vat_invoice:create", "acc.vat_invoice:read")
	t.Run("list derived fields scope state and unread count", func(t *testing.T) {
		_, insertErr := pool.Exec(ctx, `INSERT INTO bas_account(id,code,name,direction,company_id)
			VALUES($1,$2,'借方','debit',$5),($3,$4,'贷方','credit',$5)`,
			debitAccountID, "DA-"+suffix, creditAccountID, "CA-"+suffix, companyA)
		if insertErr == nil {
			_, insertErr = pool.Exec(ctx, `INSERT INTO sal_reconciliation(
				id,reconciliation_no,reconciliation_type,party_type,party_id,status,
				company_id,debit_account_id,credit_account_id)
				VALUES($1,$2,'regular','customer',$3,'confirmed',$4,$5,$6)`,
				open.SourceID, open.SourceNo, customerID, companyA, debitAccountID, creditAccountID)
		}
		if insertErr == nil {
			_, insertErr = pool.Exec(ctx, `INSERT INTO acc_vat_invoice(
			direction,party_type,party_id,invoice_kind,status,company_id,sal_reconciliation_id)
			VALUES('outbound','customer',$1,'normal','draft',$2,$3)`,
				customerID, companyA, open.SourceID)
		}
		if insertErr != nil {
			t.Fatal(insertErr)
		}
		result, queryErr := service.ListTodos(ctx, todoActorA, TodoListQuery{
			ListQuery: ListQuery{Limit: 20, Search: "SR-" + suffix}, Tab: "active",
		})
		if queryErr != nil || result.Count != 1 || len(result.Results) != 1 {
			t.Fatalf("todo result = %#v, %v", result, queryErr)
		}
		got := result.Results[0]
		if got.ID != todo.ID || got.PartyName != "客户-"+suffix || !got.DraftInvoiceLinked ||
			got.Company.ID != companyA || got.Company.Name != "公司A-"+suffix ||
			got.CreatedBy == nil || got.CreatedBy.ID != userA ||
			got.Type != "ISSUE_INVOICE" || got.Status != "ACTIVE" || got.PartyType != "CUSTOMER" {
			t.Fatalf("derived todo = %#v", got)
		}
		wrongCompany := actorFor(userA, companyB, "acc.vat_invoice:create", "acc.vat_invoice:read")
		if hidden, hiddenErr := service.ListTodos(ctx, wrongCompany, TodoListQuery{Tab: "active"}); hiddenErr != nil || hidden.Count != 0 {
			t.Fatalf("wrong-company list = %#v, %v", hidden, hiddenErr)
		}
		readOnly := actorFor(userA, companyA, "acc.vat_invoice:read")
		if _, countErr := service.UnreadCount(ctx, readOnly); countErr != nil {
			t.Fatalf("read-only unread count = %v", countErr)
		}
		if count, countErr := service.UnreadCount(ctx, todoActorA); countErr != nil || count != 1 {
			t.Fatalf("unread = %d, %v", count, countErr)
		}
		if _, markErr := service.MarkRead(ctx, todoActorA, todo.ID); markErr != nil {
			t.Fatal(markErr)
		}
		if count, countErr := service.UnreadCount(ctx, todoActorA); countErr != nil || count != 0 {
			t.Fatalf("read count = %d, %v", count, countErr)
		}
		if count, countErr := service.UnreadCount(ctx, todoActorB); countErr != nil || count != 1 {
			t.Fatalf("other user count = %d, %v", count, countErr)
		}
	})

	t.Run("concurrent mark and dismiss keep one user state", func(t *testing.T) {
		var wg sync.WaitGroup
		errs := make(chan error, 2)
		wg.Add(2)
		go func() {
			defer wg.Done()
			_, actionErr := service.MarkRead(ctx, todoActorB, todo.ID)
			errs <- actionErr
		}()
		go func() {
			defer wg.Done()
			_, actionErr := service.Dismiss(ctx, todoActorB, todo.ID)
			errs <- actionErr
		}()
		wg.Wait()
		close(errs)
		for actionErr := range errs {
			if actionErr != nil {
				t.Fatal(actionErr)
			}
		}
		var states int
		var readAt, dismissedAt, basis *time.Time
		if queryErr := pool.QueryRow(ctx, `SELECT count(*),max(read_at),max(dismissed_at),max(reset_basis_at)
			FROM sys_todo_state WHERE todo_id=$1 AND user_id=$2`, todo.ID, userB).
			Scan(&states, &readAt, &dismissedAt, &basis); queryErr != nil {
			t.Fatal(queryErr)
		}
		if states != 1 || readAt == nil || dismissedAt == nil || basis == nil {
			t.Fatalf("state count=%d read=%v dismissed=%v basis=%v", states, readAt, dismissedAt, basis)
		}
		hidden, queryErr := service.ListTodos(ctx, todoActorB, TodoListQuery{Tab: "active"})
		if queryErr != nil || hidden.Count != 0 {
			t.Fatalf("dismissed list = %#v, %v", hidden, queryErr)
		}
		included, queryErr := service.ListTodos(ctx, todoActorB, TodoListQuery{Tab: "active", IncludeDismissed: true})
		if queryErr != nil || included.Count != 1 || !included.Results[0].Dismissed {
			t.Fatalf("included list = %#v, %v", included, queryErr)
		}
	})

	t.Run("concurrent open enforces one active row", func(t *testing.T) {
		input := open
		input.SourceID, input.SourceNo = uuid.New(), "RACE-"+suffix
		start := make(chan struct{})
		errs := make(chan error, 2)
		var wg sync.WaitGroup
		for range 2 {
			wg.Add(1)
			go func() {
				defer wg.Done()
				tx, beginErr := pool.Begin(ctx)
				if beginErr != nil {
					errs <- beginErr
					return
				}
				defer tx.Rollback(ctx)
				<-start
				_, openErr := service.OpenTodo(ctx, tx, input)
				if openErr == nil {
					openErr = tx.Commit(ctx)
				}
				errs <- openErr
			}()
		}
		close(start)
		wg.Wait()
		close(errs)
		successes, conflicts := 0, 0
		for openErr := range errs {
			switch errorCode(openErr) {
			case "":
				if openErr == nil {
					successes++
				}
			case apierror.CodeConflict:
				conflicts++
			default:
				t.Fatalf("open race error = %#v", openErr)
			}
		}
		if successes != 1 || conflicts != 1 {
			t.Fatalf("successes=%d conflicts=%d", successes, conflicts)
		}
	})

	t.Run("close participates in caller transaction", func(t *testing.T) {
		tx, beginErr := pool.BeginTx(ctx, pgx.TxOptions{})
		if beginErr != nil {
			t.Fatal(beginErr)
		}
		closed, closeErr := service.CloseTodos(ctx, tx, open.SourceType, open.SourceID, TodoClosedByUnconfirm)
		if closeErr != nil || len(closed) != 1 || closed[0].Status != strings.ToUpper(TodoStatusClosed) ||
			closed[0].ClosedReason == nil || *closed[0].ClosedReason != "UNCONFIRM" {
			_ = tx.Rollback(ctx)
			t.Fatalf("closed = %#v, %v", closed, closeErr)
		}
		if commitErr := tx.Commit(ctx); commitErr != nil {
			t.Fatal(commitErr)
		}
		history, queryErr := service.ListTodos(ctx, todoActorA, TodoListQuery{Tab: "history"})
		if queryErr != nil || history.Count < 1 {
			t.Fatalf("history = %#v, %v", history, queryErr)
		}
	})
}

func actorFor(userID, companyID uuid.UUID, permissions ...string) *authz.Actor {
	grants := make(map[string]struct{}, len(permissions))
	for _, permission := range permissions {
		grants[permission] = struct{}{}
	}
	return &authz.Actor{
		UserID: userID, CompanyIDs: []uuid.UUID{companyID},
		Permissions: grants,
	}
}
