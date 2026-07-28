package outsourced

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/domain/inventory/stock"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/testutil"
)

type outsourcedFixture struct {
	pool                                      *pgxpool.Pool
	companyID, userID, currencyID, supplierID uuid.UUID
	unitID, categoryID, materialID            uuid.UUID
	mainWarehouseID, outsourcedWarehouseID    uuid.UUID
	debitAccountID, creditAccountID           uuid.UUID
	orderID, orderItemID                      uuid.UUID
	orderMaterialID, orderByproductID         uuid.UUID
	suffix                                    string
}

func TestPostgresOutsourcedIssueReceiptLifecycleAndProjectionGuards(t *testing.T) {
	f := newOutsourcedFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	actor := outsourcedActor(f)
	svc := NewService(f.pool)

	issueNo := "OI-" + f.suffix
	issue, err := svc.CreateIssue(ctx, actor, CreateIssueInput{
		CompanyID: f.companyID, IssueNo: &issueNo,
		PartyType: " SUPPLIER ", PartyID: f.supplierID,
		FromWarehouseID:       &f.mainWarehouseID,
		OutsourcedWarehouseID: &f.outsourcedWarehouseID,
	})
	if err != nil {
		t.Fatal(err)
	}
	issues, err := svc.ListIssues(ctx, actor, ListQuery{Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if issues.Count < 1 {
		t.Fatalf("公司范围内发料单 count=%d", issues.Count)
	}
	emptyScope := *actor
	emptyScope.CompanyIDs = nil
	emptyIssues, err := svc.ListIssues(ctx, &emptyScope, ListQuery{Limit: 10})
	if err != nil || emptyIssues.Count != 0 || len(emptyIssues.Results) != 0 {
		t.Fatalf("空公司范围 list=%#v error=%v", emptyIssues, err)
	}
	issueItem, err := svc.CreateIssueItem(ctx, actor, CreateIssueItemInput{
		IssueID: issue.ID, Idx: -1, Qty: decimal.NewFromInt(4),
		OrderItemMaterialID:   f.orderMaterialID,
		FromWarehouseID:       &f.mainWarehouseID,
		OutsourcedWarehouseID: &f.outsourcedWarehouseID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !issueItem.BaseQty.Equal(decimal.NewFromInt(4)) ||
		issueItem.MaterialID != f.materialID || issueItem.OrderNo != "PO-"+f.suffix {
		t.Fatalf("发料行来源快照/折算 = %#v", issueItem)
	}
	if _, err := svc.AuditIssue(ctx, actor, issue.ID); err != nil {
		t.Fatal(err)
	}
	requireDecimalColumn(t, ctx, f.pool, "pur_order_item_material", "issued_qty",
		f.orderMaterialID, "4")
	requireFactCount(t, ctx, f.pool, "inv_stock_entry",
		"purchase.outsourced_issue", issue.ID, 2, 0)

	receiptNo := "OR-" + f.suffix
	receipt, err := svc.CreateReceipt(ctx, actor, CreateReceiptInput{
		CompanyID: f.companyID, ReceiptNo: &receiptNo,
		PartyType: "SUPPLIER", PartyID: f.supplierID,
		WarehouseID:           &f.mainWarehouseID,
		OutsourcedWarehouseID: &f.outsourcedWarehouseID,
	})
	if err != nil {
		t.Fatal(err)
	}
	receiptItem, err := svc.CreateReceiptItem(ctx, actor, CreateReceiptItemInput{
		ReceiptID: receipt.ID, Idx: 1, Qty: decimal.NewFromInt(5),
		OrderItemID: f.orderItemID, WarehouseID: &f.mainWarehouseID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !receiptItem.BaseQty.Equal(decimal.NewFromInt(5)) ||
		!receiptItem.OrderBaseAmount.Equal(decimal.NewFromInt(100)) {
		t.Fatalf("入库成品快照 = %#v", receiptItem)
	}
	var materialQty, byproductQty decimal.Decimal
	if err := f.pool.QueryRow(ctx, `SELECT qty FROM pur_outsourced_receipt_item_material
		WHERE receipt_item_id=$1`, receiptItem.ID).Scan(&materialQty); err != nil {
		t.Fatal(err)
	}
	if err := f.pool.QueryRow(ctx, `SELECT qty FROM pur_outsourced_receipt_item_byproduct
		WHERE receipt_item_id=$1`, receiptItem.ID).Scan(&byproductQty); err != nil {
		t.Fatal(err)
	}
	if !materialQty.Equal(decimal.NewFromInt(2)) ||
		!byproductQty.Equal(decimal.RequireFromString("0.5")) {
		t.Fatalf("比例带出材料=%s 副产物=%s", materialQty, byproductQty)
	}
	detail, err := svc.GetReceiptDetail(ctx, actor, receipt.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(detail.Items) != 1 || len(detail.Items[0].Materials) != 1 ||
		len(detail.Items[0].Byproducts) != 1 {
		t.Fatalf("三层聚合详情 = %#v", detail)
	}
	if _, err := svc.AuditReceipt(ctx, actor, receipt.ID, AuditReceiptInput{}); err != nil {
		t.Fatal(err)
	}
	requireDecimalColumn(t, ctx, f.pool, "pur_order_item", "received_qty",
		f.orderItemID, "5")
	requireFactCount(t, ctx, f.pool, "inv_stock_entry",
		"purchase.outsourced_receipt", receipt.ID, 3, 0)
	requireFactCount(t, ctx, f.pool, "acc_gl_entry",
		"purchase.outsourced_receipt", receipt.ID, 2, 0)
	if _, err := svc.VoidIssue(ctx, actor, issue.ID); outsourcedErrorCode(err) != apierror.CodeConflict {
		t.Fatalf("外协仓材料已消耗时发料作废 error=%#v", err)
	}
	requireDecimalColumn(t, ctx, f.pool, "pur_order_item_material", "issued_qty",
		f.orderMaterialID, "4")
	requireFactCount(t, ctx, f.pool, "inv_stock_entry",
		"purchase.outsourced_issue", issue.ID, 2, 0)

	tx, err := f.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.AdjustReconciledQty(ctx, tx, AdjustReconciledQtyInput{
		ReceiptItemID: receiptItem.ID, Delta: decimal.NewFromInt(1),
	}); err != nil {
		tx.Rollback(ctx)
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.VoidReceipt(ctx, actor, receipt.ID); outsourcedErrorCode(err) != apierror.CodeConflict {
		t.Fatalf("已对账作废 error=%#v", err)
	}
	tx, err = f.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.AdjustReconciledQty(ctx, tx, AdjustReconciledQtyInput{
		ReceiptItemID: receiptItem.ID, Delta: decimal.NewFromInt(-1),
	}); err != nil {
		tx.Rollback(ctx)
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.VoidReceipt(ctx, actor, receipt.ID); err != nil {
		t.Fatal(err)
	}
	requireDecimalColumn(t, ctx, f.pool, "pur_order_item", "received_qty",
		f.orderItemID, "0")
	requireFactCount(t, ctx, f.pool, "inv_stock_entry",
		"purchase.outsourced_receipt", receipt.ID, 3, 3)
	requireFactCount(t, ctx, f.pool, "acc_gl_entry",
		"purchase.outsourced_receipt", receipt.ID, 2, 2)
	if _, err := svc.VoidIssue(ctx, actor, issue.ID); err != nil {
		t.Fatal(err)
	}
	requireDecimalColumn(t, ctx, f.pool, "pur_order_item_material", "issued_qty",
		f.orderMaterialID, "0")

	concurrentNo := "OI-C-" + f.suffix
	concurrent, err := svc.CreateIssue(ctx, actor, CreateIssueInput{
		CompanyID: f.companyID, IssueNo: &concurrentNo,
		PartyType: "supplier", PartyID: f.supplierID,
		FromWarehouseID:       &f.mainWarehouseID,
		OutsourcedWarehouseID: &f.outsourcedWarehouseID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.CreateIssueItem(ctx, actor, CreateIssueItemInput{
		IssueID: concurrent.ID, Idx: 1, Qty: decimal.NewFromInt(1),
		OrderItemMaterialID:   f.orderMaterialID,
		FromWarehouseID:       &f.mainWarehouseID,
		OutsourcedWarehouseID: &f.outsourcedWarehouseID,
	}); err != nil {
		t.Fatal(err)
	}
	results := make(chan error, 2)
	for range 2 {
		go func() {
			_, auditErr := svc.AuditIssue(ctx, actor, concurrent.ID)
			results <- auditErr
		}()
	}
	successes, conflicts := 0, 0
	for range 2 {
		if auditErr := <-results; auditErr == nil {
			successes++
		} else if outsourcedErrorCode(auditErr) == apierror.CodeConflict {
			conflicts++
		} else {
			t.Fatalf("并发审核 error=%#v", auditErr)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("并发审核 success=%d conflict=%d", successes, conflicts)
	}
	requireFactCount(t, ctx, f.pool, "inv_stock_entry",
		"purchase.outsourced_issue", concurrent.ID, 2, 0)
	requireDecimalColumn(t, ctx, f.pool, "pur_order_item_material", "issued_qty",
		f.orderMaterialID, "1")

	var drawings int
	if err := f.pool.QueryRow(ctx, `SELECT count(*) FROM sys_attachment
		WHERE owner_id=ANY($1::uuid[])`,
		[]uuid.UUID{issueItem.ID, receiptItem.ID}).Scan(&drawings); err != nil {
		t.Fatal(err)
	}
	if drawings != 0 {
		t.Fatalf("委外履约不应复制图纸, got %d", drawings)
	}
}

func newOutsourcedFixture(t *testing.T) outsourcedFixture {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	pool := testutil.NewPool(t, ctx)
	suffix := strings.ReplaceAll(uuid.NewString(), "-", "")[:12]
	f := outsourcedFixture{
		pool: pool, suffix: suffix,
		companyID: uuid.New(), userID: uuid.New(), currencyID: uuid.New(),
		supplierID: uuid.New(), unitID: uuid.New(), categoryID: uuid.New(),
		materialID: uuid.New(), mainWarehouseID: uuid.New(),
		outsourcedWarehouseID: uuid.New(), debitAccountID: uuid.New(),
		creditAccountID: uuid.New(), orderID: uuid.New(), orderItemID: uuid.New(),
		orderMaterialID: uuid.New(), orderByproductID: uuid.New(),
	}
	batch := &pgx.Batch{}
	batch.Queue(`INSERT INTO bas_currency(id,name,iso_code,active)
		VALUES($1,$2,$3,true)`, f.currencyID, "委外币-"+suffix, "OW"+suffix)
	batch.Queue(`INSERT INTO bas_company(id,code,name,short_name,base_currency_id)
		VALUES($1,$2,$3,$3,$4)`, f.companyID, "OC"+suffix, "委外公司-"+suffix, f.currencyID)
	batch.Queue(`INSERT INTO sys_user(id,username,name,hashed_password,super_admin,all_companies)
		VALUES($1,$2,$3,'test',false,false)`, f.userID, "outsourced-"+suffix, "委外用户-"+suffix)
	batch.Queue(`INSERT INTO pur_supplier(id,code,name) VALUES($1,$2,$3)`,
		f.supplierID, "OS"+suffix, "委外供应商-"+suffix)
	batch.Queue(`INSERT INTO bas_unit(id,unit_type,is_base,name,symbol,ratio)
		VALUES($1,$2,true,$3,$4,1)`, f.unitID, "outsourced-"+suffix, "委外个-"+suffix, "EA"+suffix)
	batch.Queue(`INSERT INTO inv_material_category(id,code,name,is_leaf,active)
		VALUES($1,$2,$3,true,true)`, f.categoryID, "OMC"+suffix, "委外分类-"+suffix)
	batch.Queue(`INSERT INTO inv_material(id,code,name,spec,customer_part_no,
		category_id,default_unit_id) VALUES($1,$2,$3,$4,$5,$6,$7)`,
		f.materialID, "OM"+suffix, "委外物料-"+suffix, "S-"+suffix, "P-"+suffix,
		f.categoryID, f.unitID)
	batch.Queue(`INSERT INTO inv_warehouse(
		id,name,is_leaf,active,is_outsourced,allow_negative,company_id,party_type,party_id)
		VALUES($1,$2,true,true,false,false,$3,NULL,NULL),
		($4,$5,true,true,true,false,$3,'supplier',$6)`,
		f.mainWarehouseID, "委外主仓-"+suffix, f.companyID,
		f.outsourcedWarehouseID, "委外外协仓-"+suffix, f.supplierID)
	batch.Queue(`INSERT INTO bas_account(
		id,code,name,direction,is_group,active,role,company_id,currency_id)
		VALUES($1,$2,$3,'debit',false,true,NULL,$4,$5),
		($6,$7,$8,'credit',false,true,'unbilled_payable',$4,$5)`,
		f.debitAccountID, "OD"+suffix, "委外借方-"+suffix, f.companyID, f.currencyID,
		f.creditAccountID, "OC"+suffix, "委外贷方-"+suffix)
	batch.Queue(`INSERT INTO sal_company_account_default(
		company_id,receipt_debit_account_id,receipt_credit_account_id)
		VALUES($1,$2,$3)`, f.companyID, f.debitAccountID, f.creditAccountID)
	batch.Queue(`INSERT INTO pur_order(
		id,order_no,party_type,party_id,status,company_id,currency_id,is_outsourced)
		VALUES($1,$2,'supplier',$3,'audited',$4,$5,true)`,
		f.orderID, "PO-"+suffix, f.supplierID, f.companyID, f.currencyID)
	batch.Queue(`INSERT INTO pur_order_item(
		id,idx,qty,base_qty,received_qty,price,amount,base_price,base_amount,tax_rate,
		material_code,material_name,material_spec,customer_part_no,unit_name,
		order_id,company_id,material_id,unit_id)
		VALUES($1,1,10,10,0,10,100,10,100,0.13,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
		f.orderItemID, "OM"+suffix, "委外物料-"+suffix, "S-"+suffix, "P-"+suffix,
		"委外个-"+suffix, f.orderID, f.companyID, f.materialID, f.unitID)
	batch.Queue(`INSERT INTO pur_order_item_material(
		id,quantity,issued_qty,order_item_id,company_id,material_id,unit_id)
		VALUES($1,4,0,$2,$3,$4,$5)`,
		f.orderMaterialID, f.orderItemID, f.companyID, f.materialID, f.unitID)
	batch.Queue(`INSERT INTO pur_order_item_byproduct(
		id,quantity,order_item_id,company_id,material_id,unit_id)
		VALUES($1,1,$2,$3,$4,$5)`,
		f.orderByproductID, f.orderItemID, f.companyID, f.materialID, f.unitID)
	results := pool.SendBatch(ctx, batch)
	if err := results.Close(); err != nil {
		pool.Close()
		t.Fatal(err)
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := stock.Post(ctx, tx, stock.Voucher{
		Type: "test.outsourced.seed", ID: uuid.New(), No: "SEED-" + suffix,
		CompanyID: f.companyID, PostingDate: todayUTC(),
	}, []stock.Line{{
		WarehouseID: f.mainWarehouseID, MaterialID: f.materialID,
		Quantity: decimal.NewFromInt(10),
	}}); err != nil {
		tx.Rollback(ctx)
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cleanupOutsourcedFixture(f) })
	return f
}

func cleanupOutsourcedFixture(f outsourcedFixture) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	queries := []struct {
		sql  string
		args []any
	}{
		{`DELETE FROM sys_audit_log WHERE company_id=$1`, []any{f.companyID}},
		{`DELETE FROM acc_gl_entry WHERE company_id=$1`, []any{f.companyID}},
		{`DELETE FROM inv_stock_entry WHERE company_id=$1`, []any{f.companyID}},
		{`DELETE FROM pur_outsourced_issue WHERE company_id=$1`, []any{f.companyID}},
		{`DELETE FROM pur_outsourced_receipt WHERE company_id=$1`, []any{f.companyID}},
		{`DELETE FROM pur_order WHERE id=$1`, []any{f.orderID}},
		{`DELETE FROM sal_company_account_default WHERE company_id=$1`, []any{f.companyID}},
		{`DELETE FROM inv_warehouse WHERE company_id=$1`, []any{f.companyID}},
		{`DELETE FROM bas_account WHERE company_id=$1`, []any{f.companyID}},
		{`DELETE FROM inv_material WHERE id=$1`, []any{f.materialID}},
		{`DELETE FROM inv_material_category WHERE id=$1`, []any{f.categoryID}},
		{`DELETE FROM bas_unit WHERE id=$1`, []any{f.unitID}},
		{`DELETE FROM pur_supplier WHERE id=$1`, []any{f.supplierID}},
		{`DELETE FROM sys_user WHERE id=$1`, []any{f.userID}},
		{`DELETE FROM bas_company WHERE id=$1`, []any{f.companyID}},
		{`DELETE FROM bas_currency WHERE id=$1`, []any{f.currencyID}},
	}
	for _, query := range queries {
		_, _ = f.pool.Exec(ctx, query.sql, query.args...)
	}
	f.pool.Close()
}

func outsourcedActor(f outsourcedFixture) *authz.Actor {
	return &authz.Actor{
		UserID: f.userID, Username: "outsourced-test",
		CompanyIDs: []uuid.UUID{f.companyID},
		Permissions: map[string]struct{}{
			"purchase.outsourced_issue:*":   {},
			"purchase.outsourced_receipt:*": {},
		},
	}
}

func requireDecimalColumn(t *testing.T, ctx context.Context, pool *pgxpool.Pool, table, column string, id uuid.UUID, want string) {
	t.Helper()
	var got decimal.Decimal
	if err := pool.QueryRow(ctx, `SELECT `+column+` FROM `+table+` WHERE id=$1`, id).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if !got.Equal(decimal.RequireFromString(want)) {
		t.Fatalf("%s.%s=%s want %s", table, column, got, want)
	}
}

func requireFactCount(t *testing.T, ctx context.Context, pool *pgxpool.Pool, table, voucherType string, voucherID uuid.UUID, want, cancelled int) {
	t.Helper()
	var count, cancelledCount int
	if err := pool.QueryRow(ctx, `SELECT count(*),count(*) FILTER (WHERE is_cancelled)
		FROM `+table+` WHERE voucher_type=$1 AND voucher_id=$2`,
		voucherType, voucherID).Scan(&count, &cancelledCount); err != nil {
		t.Fatal(err)
	}
	if count != want || cancelledCount != cancelled {
		t.Fatalf("%s facts=%d cancelled=%d want=%d/%d", table, count, cancelledCount, want, cancelled)
	}
}

func outsourcedErrorCode(err error) apierror.Code {
	if err == nil {
		return ""
	}
	var target *apierror.Error
	if errors.As(err, &target) {
		return target.Code
	}
	return apierror.CodeInternal
}
