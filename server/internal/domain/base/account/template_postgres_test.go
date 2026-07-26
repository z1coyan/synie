package account

import (
	"context"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

func TestPostgresAccountTemplateInitialization(t *testing.T) {
	databaseURL := os.Getenv("SYNIE_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("set SYNIE_TEST_DATABASE_URL to run the real PostgreSQL smoke test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	suffix := strings.ToLower(strings.ReplaceAll(uuid.NewString(), "-", "")[:10])
	fixture := createAccountFixture(t, ctx, pool, suffix)
	service := NewService(pool)
	actor := &authz.Actor{UserID: uuid.New(), Username: "account-template-test", CompanyIDs: []uuid.UUID{fixture.companyID}}
	outsider := &authz.Actor{UserID: uuid.New(), Username: "account-template-outsider", CompanyIDs: []uuid.UUID{fixture.otherCompanyID}}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM sys_audit_log WHERE resource = 'bas_account' AND company_id = $1", fixture.companyID)
		_, _ = pool.Exec(cleanupCtx, "UPDATE bas_account SET parent_id = NULL WHERE company_id = $1", fixture.companyID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM bas_account WHERE company_id = $1", fixture.companyID)
	})

	if _, err := service.InitializeTemplate(ctx, outsider, fixture.companyID, "SMALL"); errorCode(err) != apierror.CodeForbidden {
		t.Fatalf("outside-company template error = %#v", err)
	}
	result, err := service.InitializeTemplate(ctx, actor, fixture.companyID, "SMALL")
	if err != nil {
		t.Fatal(err)
	}
	if result.CreatedCount != 70 {
		t.Fatalf("SMALL created count = %d, want 70", result.CreatedCount)
	}
	accounts, err := service.List(ctx, actor, ListQuery{Limit: 100})
	if err != nil {
		t.Fatal(err)
	}
	if accounts.Count != 70 {
		t.Fatalf("SMALL account count = %d, want 70", accounts.Count)
	}
	roles := map[string]string{}
	for _, item := range accounts.Results {
		if item.Role != nil {
			roles[item.Code] = *item.Role
		}
		if item.ParentID != nil && item.Parent == nil {
			t.Fatalf("template account %s lacks resolved parent", item.Code)
		}
	}
	wantRoles := map[string]string{
		"1122": "RECEIVABLE", "1123": "ADVANCE_PAID",
		"2202": "PAYABLE", "2203": "ADVANCE_RECEIVED",
	}
	for code, want := range wantRoles {
		if roles[code] != want {
			t.Fatalf("role %s = %q, want %q", code, roles[code], want)
		}
	}
	if _, err := service.InitializeTemplate(ctx, actor, fixture.companyID, "SMALL"); errorCode(err) != apierror.CodeConflict {
		t.Fatalf("second template error = %#v", err)
	}
}

func TestPostgresAccountTemplateInitializationIsSerialized(t *testing.T) {
	databaseURL := os.Getenv("SYNIE_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("set SYNIE_TEST_DATABASE_URL to run the real PostgreSQL smoke test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	suffix := strings.ToLower(strings.ReplaceAll(uuid.NewString(), "-", "")[:10])
	var cnyID, companyID uuid.UUID
	if err := pool.QueryRow(ctx, "SELECT id FROM bas_currency WHERE iso_code = 'CNY' LIMIT 1").Scan(&cnyID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO bas_company (code, name, short_name, base_currency_id)
		VALUES ($1, $2, $2, $3)
		RETURNING id
	`, "T"+suffix, "模板并发公司-"+suffix, cnyID).Scan(&companyID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM sys_audit_log WHERE resource = 'bas_account' AND company_id = $1", companyID)
		_, _ = pool.Exec(cleanupCtx, "UPDATE bas_account SET parent_id = NULL WHERE company_id = $1", companyID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM bas_account WHERE company_id = $1", companyID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM bas_company WHERE id = $1", companyID)
	})

	service := NewService(pool)
	actor := &authz.Actor{UserID: uuid.New(), Username: "account-template-concurrency", CompanyIDs: []uuid.UUID{companyID}}
	errs := make(chan error, 2)
	var wg sync.WaitGroup
	wg.Add(2)
	for range 2 {
		go func() {
			defer wg.Done()
			_, err := service.InitializeTemplate(ctx, actor, companyID, "INTL")
			errs <- err
		}()
	}
	wg.Wait()
	close(errs)
	successes, conflicts := 0, 0
	for err := range errs {
		switch errorCode(err) {
		case "":
			successes++
		case apierror.CodeConflict:
			conflicts++
		default:
			t.Fatalf("concurrent template error = %#v", err)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("concurrent results = successes:%d conflicts:%d", successes, conflicts)
	}
	accounts, err := service.List(ctx, actor, ListQuery{Limit: 100})
	if err != nil {
		t.Fatal(err)
	}
	if accounts.Count != 40 {
		t.Fatalf("INTL account count = %d, want 40", accounts.Count)
	}
}
