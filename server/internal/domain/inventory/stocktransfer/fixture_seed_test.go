package stocktransfer

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type transferFixture struct {
	pool                    *pgxpool.Pool
	companyID, userID       uuid.UUID
	unitID, categoryID      uuid.UUID
	materialID              uuid.UUID
	fromID, toID, transitID uuid.UUID
	currencyID              uuid.UUID
}

func newTransferFixture(t *testing.T) transferFixture {
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
	f := transferFixture{
		pool: pool, companyID: uuid.New(), userID: uuid.New(), unitID: uuid.New(),
		categoryID: uuid.New(), materialID: uuid.New(), fromID: uuid.New(),
		toID: uuid.New(), transitID: uuid.New(), currencyID: uuid.New(),
	}
	suffix := strings.ReplaceAll(uuid.NewString(), "-", "")[:12]
	if err := seedTransferFixture(ctx, f, suffix); err != nil {
		pool.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM sys_audit_log WHERE company_id=$1", f.companyID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM inv_stock_entry WHERE company_id=$1", f.companyID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM inv_stock_transfer_item WHERE company_id=$1", f.companyID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM inv_stock_transfer WHERE company_id=$1", f.companyID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM inv_warehouse WHERE company_id=$1", f.companyID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM inv_material WHERE id=$1", f.materialID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM inv_material_category WHERE id=$1", f.categoryID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM sys_user WHERE id=$1", f.userID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM bas_company WHERE id=$1", f.companyID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM bas_unit WHERE id=$1", f.unitID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM bas_currency WHERE id=$1", f.currencyID)
		pool.Close()
	})
	return f
}

func seedTransferFixture(ctx context.Context, f transferFixture, suffix string) error {
	batch := &pgx.Batch{}
	batch.Queue(`INSERT INTO bas_currency (id,name,iso_code,active) VALUES ($1,$2,$3,true)`,
		f.currencyID, "调拨测试币-"+suffix, "T"+suffix[:2])
	batch.Queue(`INSERT INTO bas_company (id,code,name,short_name,base_currency_id)
		VALUES ($1,$2,$3,$3,$4)`, f.companyID, "T"+suffix, "调拨测试公司-"+suffix, f.currencyID)
	batch.Queue(`INSERT INTO sys_user (id,username,name,hashed_password,super_admin,all_companies)
		VALUES ($1,$2,$3,'test',true,true)`, f.userID, "transfer-"+suffix, "调拨测试用户-"+suffix)
	batch.Queue(`INSERT INTO bas_unit (id,unit_type,is_base,name,symbol,ratio)
		VALUES ($1,'weight',false,$2,$3,1)`, f.unitID, "千克-"+suffix, "kg"+suffix)
	batch.Queue(`INSERT INTO inv_material_category (id,code,name,is_leaf,active)
		VALUES ($1,$2,$3,true,true)`, f.categoryID, "TCAT"+suffix, "调拨测试分类-"+suffix)
	batch.Queue(`INSERT INTO inv_material (id,code,name,spec,category_id,default_unit_id)
		VALUES ($1,$2,$3,'M6x20',$4,$5)`,
		f.materialID, "TMAT"+suffix, "调拨测试物料-"+suffix, f.categoryID, f.unitID)
	batch.Queue(`INSERT INTO inv_warehouse (id,name,company_id,is_leaf,active,allow_negative)
		VALUES ($1,$2,$4,true,true,false),($3,$5,$4,true,true,false),($6,$7,$4,true,true,false)`,
		f.fromID, "调出仓-"+suffix, f.toID, f.companyID, "调入仓-"+suffix,
		f.transitID, "在途仓-"+suffix)
	batch.Queue(`INSERT INTO inv_stock_entry
		(company_id,warehouse_id,material_id,quantity,posting_date,voucher_type,voucher_id,voucher_no)
		VALUES ($1,$2,$3,100,CURRENT_DATE,'test.seed',$4,$5)`,
		f.companyID, f.fromID, f.materialID, uuid.New(), "SEED-"+suffix)
	results := f.pool.SendBatch(ctx, batch)
	return results.Close()
}
