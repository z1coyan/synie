package account

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/testutil"
)

func TestPostgresAccountTreeAndRoleRules(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool := testutil.NewPool(t, ctx)

	suffix := strings.ToLower(strings.ReplaceAll(uuid.NewString(), "-", "")[:10])
	fixture := createAccountFixture(t, ctx, pool, suffix)
	service := NewService(pool)
	actor := &authz.Actor{
		UserID: uuid.New(), Username: "account-postgres-test",
		CompanyIDs: []uuid.UUID{fixture.companyID},
	}

	groupRole := "RECEIVABLE"
	group, err := service.Create(ctx, actor, CreateInput{
		Code: "G" + suffix, Name: "测试汇总科目-" + suffix, Direction: "DEBIT",
		IsGroup: true, Role: &groupRole, CompanyID: fixture.companyID,
	})
	if err != nil {
		t.Fatal(err)
	}
	fixture.accountIDs = append(fixture.accountIDs, group.ID)
	if group.Role != nil {
		t.Fatalf("group role = %q, want nil", *group.Role)
	}

	role := "RECEIVABLE"
	leaf, err := service.Create(ctx, actor, CreateInput{
		Code: "L" + suffix, Name: "测试明细科目-" + suffix, Direction: "DEBIT",
		Role: &role, ParentID: &group.ID, CompanyID: fixture.companyID,
		CurrencyID: &fixture.cnyID,
	})
	if err != nil {
		t.Fatal(err)
	}
	fixture.accountIDs = append(fixture.accountIDs, leaf.ID)
	if leaf.ParentID == nil || *leaf.ParentID != group.ID || leaf.Role == nil || *leaf.Role != role {
		t.Fatalf("created leaf = %#v", leaf)
	}

	if _, err := service.Create(ctx, actor, CreateInput{
		Code: "X" + suffix, Name: "跨公司父科目-" + suffix, Direction: "DEBIT",
		ParentID: &fixture.otherAccountID, CompanyID: fixture.companyID,
	}); errorCode(err) != apierror.CodeValidation {
		t.Fatalf("cross-company parent error = %#v", err)
	}

	if _, err := service.Create(ctx, actor, CreateInput{
		Code: "F" + suffix, Name: "外币角色科目-" + suffix, Direction: "DEBIT",
		Role: &role, CompanyID: fixture.companyID, CurrencyID: &fixture.foreignCurrencyID,
	}); errorCode(err) != apierror.CodeValidation {
		t.Fatalf("foreign-currency role error = %#v", err)
	}
}

type accountFixture struct {
	pool              *pgxpool.Pool
	companyID         uuid.UUID
	otherCompanyID    uuid.UUID
	cnyID             uuid.UUID
	foreignCurrencyID uuid.UUID
	otherAccountID    uuid.UUID
	accountIDs        []uuid.UUID
}

func createAccountFixture(t *testing.T, ctx context.Context, pool *pgxpool.Pool, suffix string) *accountFixture {
	t.Helper()
	f := &accountFixture{pool: pool}
	if err := pool.QueryRow(ctx, `
		INSERT INTO bas_currency (name, iso_code, symbol)
		VALUES ($1, 'CNY', '¥')
		ON CONFLICT (iso_code) DO UPDATE SET iso_code = EXCLUDED.iso_code
		RETURNING id
	`, "人民币-"+suffix).Scan(&f.cnyID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO bas_currency (name, iso_code, symbol)
		VALUES ($1, $2, '$')
		RETURNING id
	`, "测试外币-"+suffix, strings.ToUpper(suffix[:3])).Scan(&f.foreignCurrencyID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO bas_company (code, name, short_name, base_currency_id)
		VALUES ($1, $2, $2, $3)
		RETURNING id
	`, "A"+suffix, "科目测试公司-"+suffix, f.cnyID).Scan(&f.companyID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO bas_company (code, name, short_name, base_currency_id)
		VALUES ($1, $2, $2, $3)
		RETURNING id
	`, "B"+suffix, "科目测试其他公司-"+suffix, f.cnyID).Scan(&f.otherCompanyID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO bas_account (code, name, direction, company_id)
		VALUES ($1, $2, 'debit', $3)
		RETURNING id
	`, "O"+suffix, "其他公司科目-"+suffix, f.otherCompanyID).Scan(&f.otherAccountID); err != nil {
		t.Fatal(err)
	}
	f.accountIDs = append(f.accountIDs, f.otherAccountID)
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		for i := len(f.accountIDs) - 1; i >= 0; i-- {
			_, _ = pool.Exec(cleanupCtx, "DELETE FROM sys_audit_log WHERE resource = 'bas_account' AND record_id = $1", f.accountIDs[i])
			_, _ = pool.Exec(cleanupCtx, "DELETE FROM bas_account WHERE id = $1", f.accountIDs[i])
		}
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM bas_company WHERE id = ANY($1)", []uuid.UUID{f.companyID, f.otherCompanyID})
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM bas_currency WHERE id = ANY($1)", []uuid.UUID{f.foreignCurrencyID})
	})
	return f
}

func errorCode(err error) apierror.Code {
	var appErr *apierror.Error
	if errors.As(err, &appErr) {
		return appErr.Code
	}
	return ""
}
