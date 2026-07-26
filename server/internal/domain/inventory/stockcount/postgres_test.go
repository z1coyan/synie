package stockcount

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/platform/numbering"
)

type sequenceTxNumberer struct {
	prefix string
	calls  int
}

func (n *sequenceTxNumberer) NextInTx(
	ctx context.Context,
	tx pgx.Tx,
	_ numbering.NextInput,
) (string, error) {
	n.calls++
	var one int
	if err := tx.QueryRow(ctx, "SELECT 1").Scan(&one); err != nil {
		return "", err
	}
	return fmt.Sprintf("%s-%d", n.prefix, n.calls), nil
}

type countFixture struct {
	pool        *pgxpool.Pool
	companyID   uuid.UUID
	userID      uuid.UUID
	unitID      uuid.UUID
	boxID       uuid.UUID
	categoryID  uuid.UUID
	materialID  uuid.UUID
	warehouseID uuid.UUID
	currencyID  uuid.UUID
}

func TestPostgresStockCountAggregateLifecycle(t *testing.T) {
	fixture := newCountFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	actor := &authz.Actor{
		UserID: fixture.userID, Username: "stockcount-pg-test",
		SuperAdmin: true, CompanyIDs: []uuid.UUID{fixture.companyID},
	}
	numberer := &sequenceTxNumberer{prefix: "COUNT-" + strings.ReplaceAll(uuid.NewString(), "-", "")[:12]}
	service := NewService(fixture.pool, numberer)
	counted := decimal.NewFromInt(120)
	summary := "盘点差异"
	count, err := service.Create(ctx, actor, CreateInput{
		CompanyID: fixture.companyID, WarehouseID: fixture.warehouseID,
		Summary: &summary,
		Items: []CreateItemInput{{
			MaterialID: fixture.materialID, UnitID: fixture.boxID,
			CountedQuantity: &counted,
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if numberer.calls != 1 || count.Status != StatusDraft ||
		count.CreatedByID == nil || *count.CreatedByID != fixture.userID {
		t.Fatalf("created count = %#v, numberer calls=%d", count, numberer.calls)
	}
	items, err := service.ListItems(ctx, actor, count.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || !items[0].BookQuantity.Equal(decimal.NewFromInt(10)) ||
		items[0].ConvertedCounted == nil ||
		!items[0].ConvertedCounted.Equal(decimal.NewFromInt(12)) {
		t.Fatalf("created items = %#v", items)
	}

	approved, err := service.Approve(ctx, actor, count.ID)
	if err != nil {
		t.Fatal(err)
	}
	if approved.Status != StatusAudited || approved.AuditedAt == nil ||
		approved.AuditedByID == nil || *approved.AuditedByID != fixture.userID {
		t.Fatalf("approved count = %#v", approved)
	}
	var quantity decimal.Decimal
	var cancelled bool
	if err := fixture.pool.QueryRow(ctx, `
		SELECT quantity,is_cancelled
		FROM inv_stock_entry
		WHERE voucher_type='inv.stock_count' AND voucher_id=$1
	`, count.ID).Scan(&quantity, &cancelled); err != nil {
		t.Fatal(err)
	}
	if !quantity.Equal(decimal.NewFromInt(2)) || cancelled {
		t.Fatalf("difference entry quantity=%s cancelled=%v", quantity, cancelled)
	}
	if _, err := service.UpdateItem(
		ctx, actor, items[0].ID, UpdateItemInput{CountedQuantity: &items[0].CountedQuantity},
	); stockCountErrorCode(err) != apierror.CodeConflict {
		t.Fatalf("approved item update error = %#v", err)
	}

	cancelledCount, err := service.Cancel(ctx, actor, count.ID)
	if err != nil {
		t.Fatal(err)
	}
	if cancelledCount.Status != StatusCancelled {
		t.Fatalf("cancelled count = %#v", cancelledCount)
	}
	if err := fixture.pool.QueryRow(ctx, `
		SELECT is_cancelled FROM inv_stock_entry
		WHERE voucher_type='inv.stock_count' AND voucher_id=$1
	`, count.ID).Scan(&cancelled); err != nil {
		t.Fatal(err)
	}
	if !cancelled {
		t.Fatal("cancel must mark the difference entry cancelled")
	}

	equal := decimal.NewFromInt(10)
	zeroDocNo := "ZERO-" + strings.ReplaceAll(uuid.NewString(), "-", "")[:12]
	zeroCount, err := service.Create(ctx, actor, CreateInput{
		DocNo: &zeroDocNo, CompanyID: fixture.companyID,
		WarehouseID: fixture.warehouseID,
		Items: []CreateItemInput{{
			MaterialID: fixture.materialID, UnitID: fixture.unitID,
			CountedQuantity: &equal,
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Approve(ctx, actor, zeroCount.ID); err != nil {
		t.Fatal(err)
	}
	var entryCount int
	if err := fixture.pool.QueryRow(ctx, `
		SELECT count(*) FROM inv_stock_entry
		WHERE voucher_type='inv.stock_count' AND voucher_id=$1
	`, zeroCount.ID).Scan(&entryCount); err != nil {
		t.Fatal(err)
	}
	if entryCount != 0 {
		t.Fatalf("zero-difference count created %d entries", entryCount)
	}
}

func TestPostgresStockCountRejectsStaleSnapshotAndRefreshes(t *testing.T) {
	fixture := newCountFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	actor := &authz.Actor{
		UserID: fixture.userID, Username: "stockcount-refresh-test",
		SuperAdmin: true, CompanyIDs: []uuid.UUID{fixture.companyID},
	}
	docNo := "STALE-" + strings.ReplaceAll(uuid.NewString(), "-", "")[:12]
	counted := decimal.NewFromInt(10)
	service := NewService(fixture.pool)
	count, err := service.Create(ctx, actor, CreateInput{
		DocNo: &docNo, CompanyID: fixture.companyID, WarehouseID: fixture.warehouseID,
		Items: []CreateItemInput{{
			MaterialID: fixture.materialID, UnitID: fixture.unitID,
			CountedQuantity: &counted,
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.pool.Exec(ctx, `
		INSERT INTO inv_stock_entry (
		  company_id,warehouse_id,material_id,quantity,posting_date,
		  voucher_type,voucher_id,voucher_no
		) VALUES ($1,$2,$3,1,CURRENT_DATE,'test.stock_count.stale',$4,'STALE')
	`, fixture.companyID, fixture.warehouseID, fixture.materialID, uuid.New()); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Approve(ctx, actor, count.ID); stockCountErrorCode(err) != apierror.CodeConflict {
		t.Fatalf("stale approve error = %#v", err)
	}
	refreshed, err := service.Refresh(ctx, actor, count.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !refreshed.SnapshotTakenAt.After(count.SnapshotTakenAt) {
		t.Fatalf("snapshot not advanced: before=%v after=%v", count.SnapshotTakenAt, refreshed.SnapshotTakenAt)
	}
	items, err := service.ListItems(ctx, actor, count.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || !items[0].BookQuantity.Equal(decimal.NewFromInt(11)) ||
		items[0].CountedQuantity == nil ||
		!items[0].CountedQuantity.Equal(counted) {
		t.Fatalf("refreshed items = %#v", items)
	}
}

func newCountFixture(t *testing.T) countFixture {
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
	suffix := strings.ReplaceAll(uuid.NewString(), "-", "")[:12]
	fixture := countFixture{
		pool: pool, companyID: uuid.New(), userID: uuid.New(),
		unitID: uuid.New(), boxID: uuid.New(), categoryID: uuid.New(),
		materialID: uuid.New(), warehouseID: uuid.New(), currencyID: uuid.New(),
	}
	if err := seedCountFixture(ctx, fixture, suffix); err != nil {
		pool.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM sys_audit_log WHERE company_id=$1", fixture.companyID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM inv_stock_entry WHERE company_id=$1", fixture.companyID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM inv_stock_count_item WHERE company_id=$1", fixture.companyID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM inv_stock_count WHERE company_id=$1", fixture.companyID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM inv_material_unit WHERE material_id=$1", fixture.materialID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM inv_warehouse WHERE company_id=$1", fixture.companyID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM inv_material WHERE id=$1", fixture.materialID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM inv_material_category WHERE id=$1", fixture.categoryID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM sys_user WHERE id=$1", fixture.userID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM bas_company WHERE id=$1", fixture.companyID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM bas_unit WHERE id=ANY($1::uuid[])", []uuid.UUID{fixture.unitID, fixture.boxID})
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM bas_currency WHERE id=$1", fixture.currencyID)
		pool.Close()
	})
	return fixture
}

func seedCountFixture(ctx context.Context, fixture countFixture, suffix string) error {
	batch := &pgx.Batch{}
	batch.Queue(
		`INSERT INTO bas_currency (id,name,iso_code,active) VALUES ($1,$2,$3,true)`,
		fixture.currencyID, "盘点测试币-"+suffix, "C"+suffix,
	)
	batch.Queue(
		`INSERT INTO bas_company (id,code,name,short_name,base_currency_id)
		 VALUES ($1,$2,$3,$3,$4)`,
		fixture.companyID, "C"+suffix, "盘点测试公司-"+suffix, fixture.currencyID,
	)
	batch.Queue(
		`INSERT INTO sys_user (id,username,name,hashed_password,super_admin,all_companies)
		 VALUES ($1,$2,$3,'test',true,true)`,
		fixture.userID, "count-"+suffix, "盘点测试用户-"+suffix,
	)
	batch.Queue(
		`INSERT INTO bas_unit (id,unit_type,is_base,name,symbol,ratio)
		 VALUES ($1,'weight',false,$2,$3,1),($4,'quantity',false,$5,$6,1)`,
		fixture.unitID, "千克-"+suffix, "kg"+suffix,
		fixture.boxID, "箱-"+suffix, "box"+suffix,
	)
	batch.Queue(
		`INSERT INTO inv_material_category (id,code,name,is_leaf,active)
		 VALUES ($1,$2,$3,true,true)`,
		fixture.categoryID, "CCAT"+suffix, "盘点测试分类-"+suffix,
	)
	batch.Queue(
		`INSERT INTO inv_material (id,code,name,spec,category_id,default_unit_id)
		 VALUES ($1,$2,$3,'M6x20',$4,$5)`,
		fixture.materialID, "CMAT"+suffix, "盘点测试物料-"+suffix,
		fixture.categoryID, fixture.unitID,
	)
	batch.Queue(
		`INSERT INTO inv_material_unit (id,material_id,unit_id,factor)
		 VALUES ($1,$2,$3,10)`,
		uuid.New(), fixture.materialID, fixture.boxID,
	)
	batch.Queue(
		`INSERT INTO inv_warehouse (id,name,company_id,is_leaf,active,allow_negative)
		 VALUES ($1,$2,$3,true,true,false)`,
		fixture.warehouseID, "盘点测试仓-"+suffix, fixture.companyID,
	)
	batch.Queue(
		`INSERT INTO inv_stock_entry (
		  company_id,warehouse_id,material_id,quantity,posting_date,
		  voucher_type,voucher_id,voucher_no
		 ) VALUES ($1,$2,$3,10,CURRENT_DATE,'test.stock_count.seed',$4,'SEED')`,
		fixture.companyID, fixture.warehouseID, fixture.materialID, uuid.New(),
	)
	results := fixture.pool.SendBatch(ctx, batch)
	return results.Close()
}

func stockCountErrorCode(err error) apierror.Code {
	var target *apierror.Error
	if errors.As(err, &target) {
		return target.Code
	}
	return ""
}
