package filterbuild_test

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
	"github.com/z1coyan/synie/server/internal/domain/base/account"
	"github.com/z1coyan/synie/server/internal/domain/inventory/warehouse"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

// TestCompanyIsolationListCannotSeeForeignCompany proves fail-closed company
// filtering on representative List services: actor authorized only for company A
// must not observe rows planted under company B.
func TestCompanyIsolationListCannotSeeForeignCompany(t *testing.T) {
	databaseURL := os.Getenv("SYNIE_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("set SYNIE_TEST_DATABASE_URL to run the real PostgreSQL test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	suffix := strings.ToLower(strings.ReplaceAll(uuid.NewString(), "-", "")[:10])
	var cnyID, companyA, companyB, accountA, accountB, whA, whB uuid.UUID

	if err = pool.QueryRow(ctx, `
		INSERT INTO bas_currency (name, iso_code, symbol)
		VALUES ($1, 'CNY', '¥')
		ON CONFLICT (iso_code) DO UPDATE SET iso_code = EXCLUDED.iso_code
		RETURNING id
	`, "人民币-iso-"+suffix).Scan(&cnyID); err != nil {
		t.Fatal(err)
	}
	if err = pool.QueryRow(ctx, `
		INSERT INTO bas_company (code, name, short_name, base_currency_id)
		VALUES ($1, $2, $2, $3) RETURNING id
	`, "A"+suffix, "隔离A-"+suffix, cnyID).Scan(&companyA); err != nil {
		t.Fatal(err)
	}
	if err = pool.QueryRow(ctx, `
		INSERT INTO bas_company (code, name, short_name, base_currency_id)
		VALUES ($1, $2, $2, $3) RETURNING id
	`, "B"+suffix, "隔离B-"+suffix, cnyID).Scan(&companyB); err != nil {
		t.Fatal(err)
	}
	if err = pool.QueryRow(ctx, `
		INSERT INTO bas_account (code, name, direction, company_id)
		VALUES ($1, $2, 'debit', $3) RETURNING id
	`, "AA"+suffix, "科目A-"+suffix, companyA).Scan(&accountA); err != nil {
		t.Fatal(err)
	}
	if err = pool.QueryRow(ctx, `
		INSERT INTO bas_account (code, name, direction, company_id)
		VALUES ($1, $2, 'debit', $3) RETURNING id
	`, "BB"+suffix, "科目B-"+suffix, companyB).Scan(&accountB); err != nil {
		t.Fatal(err)
	}
	if err = pool.QueryRow(ctx, `
		INSERT INTO inv_warehouse (name, is_leaf, active, is_outsourced, allow_negative, company_id)
		VALUES ($1, true, true, false, false, $2) RETURNING id
	`, "仓A-"+suffix, companyA).Scan(&whA); err != nil {
		t.Fatal(err)
	}
	if err = pool.QueryRow(ctx, `
		INSERT INTO inv_warehouse (name, is_leaf, active, is_outsourced, allow_negative, company_id)
		VALUES ($1, true, true, false, false, $2) RETURNING id
	`, "仓B-"+suffix, companyB).Scan(&whB); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cctx, ccancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer ccancel()
		_, _ = pool.Exec(cctx, `DELETE FROM inv_warehouse WHERE id=ANY($1::uuid[])`, []uuid.UUID{whA, whB})
		_, _ = pool.Exec(cctx, `DELETE FROM bas_account WHERE id=ANY($1::uuid[])`, []uuid.UUID{accountA, accountB})
		_, _ = pool.Exec(cctx, `DELETE FROM bas_company WHERE id=ANY($1::uuid[])`, []uuid.UUID{companyA, companyB})
	})

	actorA := &authz.Actor{
		UserID:     uuid.New(),
		Username:   "company-isolation-a",
		CompanyIDs: []uuid.UUID{companyA},
	}
	super := &authz.Actor{UserID: uuid.New(), SuperAdmin: true}

	accountSvc := account.NewService(pool)
	listA, err := accountSvc.List(ctx, actorA, account.ListQuery{Limit: 100})
	if err != nil {
		t.Fatal(err)
	}
	var sawAccountA, sawAccountB bool
	for _, item := range listA.Results {
		if item.ID == accountA {
			sawAccountA = true
		}
		if item.ID == accountB || item.CompanyID == companyB {
			sawAccountB = true
		}
	}
	if !sawAccountA {
		t.Fatal("actor A should see own company account")
	}
	if sawAccountB {
		t.Fatal("actor A must not see company B accounts")
	}

	listAll, err := accountSvc.List(ctx, super, account.ListQuery{Limit: 200})
	if err != nil {
		t.Fatal(err)
	}
	sawAccountB = false
	for _, item := range listAll.Results {
		if item.ID == accountB {
			sawAccountB = true
			break
		}
	}
	if !sawAccountB {
		t.Fatal("superadmin should see company B account")
	}

	whSvc := warehouse.NewService(pool)
	whList, err := whSvc.List(ctx, actorA, warehouse.ListQuery{Limit: 100})
	if err != nil {
		t.Fatal(err)
	}
	var sawWhA, sawWhB bool
	for _, item := range whList.Results {
		if item.ID == whA {
			sawWhA = true
		}
		if item.ID == whB || item.CompanyID == companyB {
			sawWhB = true
		}
	}
	if !sawWhA {
		t.Fatal("actor A should see own warehouse")
	}
	if sawWhB {
		t.Fatal("actor A must not see company B warehouse")
	}

	emptyActor := &authz.Actor{UserID: uuid.New(), Username: "no-companies"}
	emptyList, err := accountSvc.List(ctx, emptyActor, account.ListQuery{Limit: 20})
	if err != nil {
		t.Fatal(err)
	}
	if emptyList.Count != 0 || len(emptyList.Results) != 0 {
		t.Fatalf("empty company actor must see nothing, got count=%d n=%d", emptyList.Count, len(emptyList.Results))
	}

	where, args, empty := filterbuild.AppendCompanyFilter(actorA, "", nil, "company_id")
	if empty {
		t.Fatal("actor A should not be empty-scoped")
	}
	var count int
	q := fmt.Sprintf(`SELECT count(*) FROM bas_account%s AND id=$%d`, where, len(args)+1)
	if err = pool.QueryRow(ctx, q, append(args, accountB)...).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("filtered SQL must exclude B account, count=%d", count)
	}
}
