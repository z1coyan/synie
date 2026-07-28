package stock

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/testutil"
)

type pgFixture struct {
	pool        *pgxpool.Pool
	companyID   uuid.UUID
	unitID      uuid.UUID
	categoryID  uuid.UUID
	materialID  uuid.UUID
	warehouseID uuid.UUID
	otherWHID   uuid.UUID
}

func TestPostgresEngineFactsBalanceAndSameVoucherStages(t *testing.T) {
	fixture := newPGFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	voucherID := uuid.New()

	tx, err := fixture.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	voucher := Voucher{
		Type: "inv.stock_transfer", ID: voucherID, No: "TX-" + voucherID.String(),
		CompanyID: fixture.companyID, PostingDate: time.Date(2026, 7, 26, 0, 0, 0, 0, time.UTC),
	}
	if err := Post(ctx, tx, voucher, []Line{{
		WarehouseID: fixture.warehouseID, MaterialID: fixture.materialID,
		Quantity: decimal.NewFromInt(10),
	}}); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatal(err)
	}
	// The same voucher posts again in a later business stage. The engine must
	// not enforce a global (voucher_type,voucher_id) single-use rule.
	if err := Post(ctx, tx, voucher, []Line{{
		WarehouseID: fixture.otherWHID, MaterialID: fixture.materialID,
		Quantity: decimal.NewFromInt(2),
	}}); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	var count int
	if err := fixture.pool.QueryRow(ctx, `
		SELECT count(*) FROM inv_stock_entry
		WHERE voucher_type='inv.stock_transfer' AND voucher_id=$1
	`, voucherID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 2 {
		t.Fatalf("entry count = %d, want 2", count)
	}
	rows, err := Balance(ctx, fixture.pool, BalanceQuery{
		CompanyID: fixture.companyID, AsOf: voucher.PostingDate, HideZero: false,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 {
		t.Fatalf("balance rows = %#v", rows)
	}

	tx, err = fixture.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := Cancel(ctx, tx, VoucherRef{Type: voucher.Type, ID: voucher.ID}, time.Now()); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	tx, err = fixture.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := Cancel(ctx, tx, VoucherRef{Type: voucher.Type, ID: voucher.ID}, time.Now()); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("idempotent cancel: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestPostgresConcurrentOutgoingSerializesByBalanceKey(t *testing.T) {
	fixture := newPGFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	seedVoucher := Voucher{
		Type: "inv.stock_doc", ID: uuid.New(), No: "SEED-" + uuid.NewString(),
		CompanyID: fixture.companyID, PostingDate: time.Now(),
	}
	tx, err := fixture.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := Post(ctx, tx, seedVoucher, []Line{{
		WarehouseID: fixture.warehouseID, MaterialID: fixture.materialID,
		Quantity: decimal.NewFromInt(1),
	}}); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed post: %v; cause: %v", err, errors.Unwrap(err))
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	start := make(chan struct{})
	results := make(chan error, 2)
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			runTx, beginErr := fixture.pool.Begin(ctx)
			if beginErr != nil {
				results <- beginErr
				return
			}
			voucher := Voucher{
				Type: "inv.stock_doc", ID: uuid.New(), No: "OUT-" + uuid.NewString(),
				CompanyID: fixture.companyID, PostingDate: time.Now(),
			}
			postErr := Post(ctx, runTx, voucher, []Line{{
				WarehouseID: fixture.warehouseID, MaterialID: fixture.materialID,
				Quantity: decimal.NewFromInt(-1),
			}})
			if postErr != nil {
				_ = runTx.Rollback(ctx)
				results <- postErr
				return
			}
			results <- runTx.Commit(ctx)
		}()
	}
	close(start)
	wg.Wait()
	close(results)
	successes, failures := 0, 0
	for result := range results {
		if result == nil {
			successes++
		} else {
			failures++
		}
	}
	if successes != 1 || failures != 1 {
		t.Fatalf("successes=%d failures=%d", successes, failures)
	}
	var balance decimal.Decimal
	if err := fixture.pool.QueryRow(ctx, `
		SELECT COALESCE(sum(quantity),0)
		FROM inv_stock_entry
		WHERE warehouse_id=$1 AND material_id=$2 AND is_cancelled=false
	`, fixture.warehouseID, fixture.materialID).Scan(&balance); err != nil {
		t.Fatal(err)
	}
	if !balance.IsZero() {
		t.Fatalf("balance = %s", balance)
	}
}

func newPGFixture(t *testing.T) pgFixture {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pool := testutil.NewPool(t, ctx)
	suffix := strings.ReplaceAll(uuid.NewString(), "-", "")[:12]
	fixture := pgFixture{
		pool: pool, companyID: uuid.New(), unitID: uuid.New(),
		categoryID: uuid.New(), materialID: uuid.New(),
		warehouseID: uuid.New(), otherWHID: uuid.New(),
	}
	currencyID := uuid.New()
	if err := seedPGFixture(ctx, pool, fixture, currencyID, suffix); err != nil {
		pool.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM inv_stock_entry WHERE company_id=$1", fixture.companyID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM inv_material_unit WHERE material_id=$1", fixture.materialID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM inv_warehouse WHERE company_id=$1", fixture.companyID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM inv_material WHERE id=$1", fixture.materialID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM inv_material_category WHERE id=$1", fixture.categoryID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM bas_company WHERE id=$1", fixture.companyID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM bas_unit WHERE id=$1", fixture.unitID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM bas_currency WHERE id=$1", currencyID)
		pool.Close()
	})
	return fixture
}
