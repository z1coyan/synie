package glentry

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/engines/gl"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

func TestPostgresListAndARAPReport(t *testing.T) {
	databaseURL := os.Getenv("SYNIE_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("set SYNIE_TEST_DATABASE_URL to run the real PostgreSQL tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	suffix := strings.ToUpper(strings.ReplaceAll(uuid.NewString(), "-", ""))
	currencyID, companyID := uuid.New(), uuid.New()
	receivableID, cashID, customerID := uuid.New(), uuid.New(), uuid.New()
	voucherID := uuid.New()
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM acc_gl_entry WHERE company_id=$1", companyID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM bas_account WHERE company_id=$1", companyID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM sal_customers WHERE id=$1", customerID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM bas_company WHERE id=$1", companyID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM bas_currency WHERE id=$1", currencyID)
		pool.Close()
	})
	if _, err := pool.Exec(ctx,
		`INSERT INTO bas_currency (id,name,iso_code,active) VALUES ($1,$2,$3,true)`,
		currencyID, "报表测试币-"+suffix[:8], suffix[:3],
	); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx,
		`INSERT INTO bas_company (id,code,name,short_name,base_currency_id)
		 VALUES ($1,$2,$3,$3,$4)`,
		companyID, suffix[:2], "报表测试公司-"+suffix[:8], currencyID,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO bas_account
			(id,code,name,direction,is_group,active,role,company_id)
		VALUES
			($1,'1122','应收账款','debit',false,true,'receivable',$3),
			($2,'1001','库存现金','debit',false,true,NULL,$3)
	`, receivableID, cashID, companyID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx,
		`INSERT INTO sal_customers (id,code,name) VALUES ($1,$2,$3)`,
		customerID, "C"+suffix[:8], "报表客户-"+suffix[:8],
	); err != nil {
		t.Fatal(err)
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	partyType := "customer"
	postingDate := time.Date(2026, 7, 20, 0, 0, 0, 0, time.UTC)
	if err := gl.Post(ctx, tx, gl.Voucher{
		Type: "acc.gl_journal", ID: voucherID, No: "记-" + suffix[:12],
		CompanyID: companyID, PostingDate: postingDate,
	}, []gl.Entry{
		{
			AccountID: receivableID, Debit: decimal.NewFromInt(125),
			PartyType: &partyType, PartyID: &customerID,
		},
		{AccountID: cashID, Credit: decimal.NewFromInt(125)},
	}); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	actor := &authz.Actor{SuperAdmin: true}
	service := NewService(pool)
	list, err := service.List(ctx, actor, ListQuery{Limit: 20})
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, entry := range list.Results {
		if entry.VoucherID == voucherID {
			found = true
		}
	}
	if !found {
		t.Fatal("posted entries absent from list")
	}
	report, err := service.Report(ctx, actor, ReportQuery{
		CompanyID: companyID, AsOf: time.Date(2026, 7, 31, 0, 0, 0, 0, time.UTC),
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Rows) != 1 {
		t.Fatalf("report rows = %#v", report.Rows)
	}
	row := report.Rows[0]
	if row.PartyLabel != "报表客户-"+suffix[:8] ||
		!row.Balances["receivable"].Equal(decimal.NewFromInt(125)) ||
		!row.NetReceivable.Equal(decimal.NewFromInt(125)) {
		t.Fatalf("report row = %#v", row)
	}
}
