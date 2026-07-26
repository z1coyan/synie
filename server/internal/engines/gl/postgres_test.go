package gl

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"
)

func TestPostgresPostReverseAndCancel(t *testing.T) {
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
	defer pool.Close()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)

	suffix := strings.ToUpper(strings.ReplaceAll(uuid.NewString(), "-", ""))
	currencyID, companyID := uuid.New(), uuid.New()
	receivableID, cashID := uuid.New(), uuid.New()
	if _, err := tx.Exec(ctx,
		`INSERT INTO bas_currency (id,name,iso_code,active) VALUES ($1,$2,$3,true)`,
		currencyID, "总账测试币-"+suffix[:8], suffix[:3],
	); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO bas_company (id,code,name,short_name,base_currency_id)
		 VALUES ($1,$2,$3,$3,$4)`,
		companyID, suffix[:2], "总账测试公司-"+suffix[:8], currencyID,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO bas_account
			(id,code,name,direction,is_group,active,role,company_id)
		VALUES
			($1,'1122','应收账款','debit',false,true,'receivable',$3),
			($2,'1001','库存现金','debit',false,true,NULL,$3)
	`, receivableID, cashID, companyID); err != nil {
		t.Fatal(err)
	}

	partyType, partyID := "customer", uuid.New()
	voucher := Voucher{
		Type: "acc.gl_journal", ID: uuid.New(), No: "记-" + suffix[:12],
		CompanyID: companyID, PostingDate: time.Date(2026, 7, 26, 0, 0, 0, 0, time.UTC),
	}
	entries := []Entry{
		{
			AccountID: receivableID, Debit: decimal.NewFromInt(100),
			PartyType: &partyType, PartyID: &partyID,
		},
		{AccountID: cashID, Credit: decimal.NewFromInt(100)},
	}
	if err := Post(ctx, tx, voucher, entries); err != nil {
		t.Fatal(err)
	}
	assertFactCounts(t, ctx, tx, voucher.ID, 2, 0, 0, 0)

	reversalDate := time.Date(2026, 7, 31, 0, 0, 0, 0, time.UTC)
	if err := Reverse(ctx, tx, VoucherRef{Type: voucher.Type, ID: voucher.ID}, reversalDate); err != nil {
		t.Fatal(err)
	}
	assertFactCounts(t, ctx, tx, voucher.ID, 4, 2, 2, 0)
	if err := Reverse(ctx, tx, VoucherRef{Type: voucher.Type, ID: voucher.ID}, reversalDate); err == nil {
		t.Fatal("repeated reversal succeeded")
	}

	if err := Cancel(ctx, tx, VoucherRef{Type: voucher.Type, ID: voucher.ID}); err != nil {
		t.Fatal(err)
	}
	if err := Cancel(ctx, tx, VoucherRef{Type: voucher.Type, ID: voucher.ID}); err != nil {
		t.Fatalf("idempotent cancel: %v", err)
	}
	assertFactCounts(t, ctx, tx, voucher.ID, 4, 2, 2, 4)
}

func assertFactCounts(
	t *testing.T,
	ctx context.Context,
	tx pgx.Tx,
	voucherID uuid.UUID,
	total, reversed, reversal, cancelled int,
) {
	t.Helper()
	var gotTotal, gotReversed, gotReversal, gotCancelled int
	if err := tx.QueryRow(ctx, `
		SELECT count(*),
		       count(*) FILTER (WHERE is_reversed),
		       count(*) FILTER (WHERE is_reversal),
		       count(*) FILTER (WHERE is_cancelled)
		FROM acc_gl_entry WHERE voucher_id=$1
	`, voucherID).Scan(&gotTotal, &gotReversed, &gotReversal, &gotCancelled); err != nil {
		t.Fatal(err)
	}
	if gotTotal != total || gotReversed != reversed ||
		gotReversal != reversal || gotCancelled != cancelled {
		t.Fatalf(
			"facts=(%d,%d,%d,%d), want=(%d,%d,%d,%d)",
			gotTotal, gotReversed, gotReversal, gotCancelled,
			total, reversed, reversal, cancelled,
		)
	}
}
