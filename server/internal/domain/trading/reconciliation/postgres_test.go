package reconciliation

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/platform/numbering"
)

type testNumberer struct {
	mu sync.Mutex
	n  int
}

func (n *testNumberer) NextInTx(
	_ context.Context, _ pgx.Tx, input numbering.NextInput,
) (string, error) {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.n++
	return fmt.Sprintf("REC-%s-%d", input.Resource, n.n), nil
}

type fixture struct {
	pool                          *pgxpool.Pool
	company, otherCompany         uuid.UUID
	customer, supplier            uuid.UUID
	salesDebit, salesCredit       uuid.UUID
	purchaseDebit, purchaseCredit uuid.UUID
	deliveryItem, receiptItem     uuid.UUID
	outsourcedReceiptItem         uuid.UUID
	actor                         *authz.Actor
}

func TestPostgresRegularLifecycleTodoInvoiceSeamAndConcurrency(t *testing.T) {
	f := newFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	svc := NewService(f.pool, &testNumberer{})

	head, err := svc.CreateHead(ctx, f.actor, SideSales, CreateHeadInput{
		CompanyID: f.company, Kind: KindRegular, PartyType: "CUSTOMER",
		PartyID: f.customer,
	})
	if err != nil {
		t.Fatal(err)
	}
	if head.DebitAccountID != f.salesDebit || head.CreditAccountID != f.salesCredit {
		t.Fatalf("公司默认科目未带入: %#v", head)
	}
	item, err := svc.CreateItem(ctx, f.actor, SideSales, CreateItemInput{
		ReconciliationID: head.ID, Idx: 1, Qty: decimal.RequireFromString("2.005"),
		DeliveryItemID: &f.deliveryItem,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !item.BaseQty.Equal(decimal.RequireFromString("4.010000")) ||
		!item.Amount.Equal(decimal.RequireFromString("20.05")) ||
		!item.BaseAmount.Equal(decimal.RequireFromString("24.06")) {
		t.Fatalf("金额快照错误: %#v", item)
	}

	var wg sync.WaitGroup
	errs := make(chan error, 2)
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, callErr := svc.Confirm(ctx, f.actor, SideSales, head.ID)
			errs <- callErr
		}()
	}
	wg.Wait()
	close(errs)
	success, conflict := 0, 0
	for callErr := range errs {
		if callErr == nil {
			success++
		} else if code(callErr) == apierror.CodeConflict {
			conflict++
		} else {
			t.Fatalf("并发确认错误: %v", callErr)
		}
	}
	if success != 1 || conflict != 1 {
		t.Fatalf("并发确认 success=%d conflict=%d", success, conflict)
	}
	confirmed, err := svc.GetHead(ctx, f.actor, SideSales, head.ID)
	if err != nil {
		t.Fatal(err)
	}
	if confirmed.Status != StatusConfirmed {
		t.Fatalf("状态 = %s", confirmed.Status)
	}
	filtered, err := svc.ListHeads(ctx, f.actor, SideSales, ListQuery{
		Search: head.No,
		Sort:   &filterbuild.Sort{Column: "reconciliationNo", Direction: "descending"},
		Filter: map[string]json.RawMessage{
			"status": json.RawMessage(`{"kind":"enum","values":["CONFIRMED"]}`),
		},
	})
	if err != nil || filtered.Count != 1 || len(filtered.Results) != 1 ||
		filtered.Results[0].ID != head.ID {
		t.Fatalf("结构化查询 = %#v err=%v", filtered, err)
	}
	filteredItems, err := svc.ListItems(ctx, f.actor, SideSales, ListQuery{
		Sort: &filterbuild.Sort{Column: "idx", Direction: "ascending"},
		Filter: map[string]json.RawMessage{
			"qty": json.RawMessage(`{"kind":"number","op":"eq","value":"2.005"}`),
		},
	})
	if err != nil || filteredItems.Count != 1 || filteredItems.Results[0].ID != item.ID {
		t.Fatalf("条目结构化查询 = %#v err=%v", filteredItems, err)
	}
	var projected decimal.Decimal
	if err := f.pool.QueryRow(ctx, `SELECT reconciled_qty FROM sal_delivery_item WHERE id=$1`,
		f.deliveryItem).Scan(&projected); err != nil {
		t.Fatal(err)
	}
	if !projected.Equal(decimal.RequireFromString("4.01")) {
		t.Fatalf("投影 = %s", projected)
	}
	var todoCount int
	if err := f.pool.QueryRow(ctx, `SELECT COUNT(*) FROM sys_todo
		WHERE source_type='sales.reconciliation' AND source_id=$1 AND status='active'`,
		head.ID).Scan(&todoCount); err != nil || todoCount != 1 {
		t.Fatalf("待办 count=%d err=%v", todoCount, err)
	}

	tx, err := f.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	closed, err := svc.CloseFromInvoice(ctx, tx, f.actor, SideSales, head.ID)
	if err != nil {
		tx.Rollback(ctx)
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil || closed.Status != StatusClosed {
		t.Fatalf("发票结单 = %#v err=%v", closed, err)
	}
	tx, err = f.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	reopened, err := svc.ReopenFromInvoice(ctx, tx, f.actor, SideSales, head.ID)
	if err != nil {
		tx.Rollback(ctx)
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil || reopened.Status != StatusConfirmed {
		t.Fatalf("发票重开 = %#v err=%v", reopened, err)
	}
	if _, err := svc.Unconfirm(ctx, f.actor, SideSales, head.ID); err != nil {
		t.Fatal(err)
	}

	first := createSalesReconciliation(t, ctx, svc, f, decimal.NewFromInt(6))
	second := createSalesReconciliation(t, ctx, svc, f, decimal.NewFromInt(6))
	errs = make(chan error, 2)
	for _, id := range []uuid.UUID{first, second} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, callErr := svc.Confirm(ctx, f.actor, SideSales, id)
			errs <- callErr
		}()
	}
	wg.Wait()
	close(errs)
	success, conflict = 0, 0
	for callErr := range errs {
		if callErr == nil {
			success++
		} else if code(callErr) == apierror.CodeConflict {
			conflict++
		} else {
			t.Fatalf("跨单剩余量竞争错误: %v", callErr)
		}
	}
	if success != 1 || conflict != 1 {
		t.Fatalf("跨单竞争 success=%d conflict=%d", success, conflict)
	}
}

func createSalesReconciliation(
	t *testing.T, ctx context.Context, svc *Service, f fixture, qty decimal.Decimal,
) uuid.UUID {
	t.Helper()
	head, err := svc.CreateHead(ctx, f.actor, SideSales, CreateHeadInput{
		CompanyID: f.company, Kind: KindRegular, PartyType: "customer", PartyID: f.customer,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.CreateItem(ctx, f.actor, SideSales, CreateItemInput{
		ReconciliationID: head.ID, Idx: 1, Qty: qty, DeliveryItemID: &f.deliveryItem,
	}); err != nil {
		t.Fatal(err)
	}
	return head.ID
}

func TestPostgresGiftGLCancelAndPurchaseSources(t *testing.T) {
	f := newFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	svc := NewService(f.pool, &testNumberer{})

	gift, err := svc.CreateHead(ctx, f.actor, SideSales, CreateHeadInput{
		CompanyID: f.company, Kind: KindGiftSample, PartyType: "customer",
		PartyID: f.customer, DebitAccountID: f.salesDebit, CreditAccountID: f.salesCredit,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.CreateItem(ctx, f.actor, SideSales, CreateItemInput{
		ReconciliationID: gift.ID, Idx: 1, Qty: decimal.NewFromInt(1),
		DeliveryItemID: &f.deliveryItem,
	}); err != nil {
		t.Fatal(err)
	}
	closed, err := svc.Audit(ctx, f.actor, SideSales, gift.ID, AuditInput{})
	if err != nil {
		t.Fatal(err)
	}
	if closed.Status != StatusClosed || closed.PostingDate == nil {
		t.Fatalf("赠送结单 = %#v", closed)
	}
	var liveGL int
	if err := f.pool.QueryRow(ctx, `SELECT COUNT(*) FROM acc_gl_entry
		WHERE voucher_type='sales.reconciliation' AND voucher_id=$1 AND NOT is_cancelled`,
		gift.ID).Scan(&liveGL); err != nil || liveGL != 2 {
		t.Fatalf("GL count=%d err=%v", liveGL, err)
	}
	if _, err := svc.Void(ctx, f.actor, SideSales, gift.ID); err != nil {
		t.Fatal(err)
	}
	if err := f.pool.QueryRow(ctx, `SELECT COUNT(*) FROM acc_gl_entry
		WHERE voucher_type='sales.reconciliation' AND voucher_id=$1 AND NOT is_cancelled`,
		gift.ID).Scan(&liveGL); err != nil || liveGL != 0 {
		t.Fatalf("GL cancel count=%d err=%v", liveGL, err)
	}

	purchase, err := svc.CreateHead(ctx, f.actor, SidePurchase, CreateHeadInput{
		CompanyID: f.company, Kind: KindRegular, PartyType: "supplier",
		PartyID: f.supplier,
	})
	if err != nil {
		t.Fatal(err)
	}
	if purchase.DebitAccountID != f.purchaseDebit ||
		purchase.CreditAccountID != f.purchaseCredit {
		t.Fatalf("采购默认科目未带入: %#v", purchase)
	}
	if _, err := svc.CreateItem(ctx, f.actor, SidePurchase, CreateItemInput{
		ReconciliationID: purchase.ID, Idx: 1, Qty: decimal.NewFromInt(1),
		ReceiptItemID: &f.receiptItem, OutsourcedReceiptItemID: &f.outsourcedReceiptItem,
	}); code(err) != apierror.CodeValidation {
		t.Fatalf("来源恰一 err=%v", err)
	}
	if _, err := svc.CreateItem(ctx, f.actor, SidePurchase, CreateItemInput{
		ReconciliationID: purchase.ID, Idx: 1, Qty: decimal.NewFromInt(1),
		ReceiptItemID: &f.receiptItem,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.CreateItem(ctx, f.actor, SidePurchase, CreateItemInput{
		ReconciliationID: purchase.ID, Idx: 2, Qty: decimal.NewFromInt(1),
		OutsourcedReceiptItemID: &f.outsourcedReceiptItem,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Confirm(ctx, f.actor, SidePurchase, purchase.ID); err != nil {
		t.Fatal(err)
	}
}

func TestPermissionBeforeInputAndCompanyScope(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	svc := NewService(f.pool, &testNumberer{})
	if _, err := svc.CreateHead(ctx, &authz.Actor{}, SideSales, CreateHeadInput{}); code(err) != apierror.CodeForbidden {
		t.Fatalf("权限优先 err=%v", err)
	}
	head, err := svc.CreateHead(ctx, f.actor, SideSales, CreateHeadInput{
		CompanyID: f.company, Kind: KindGiftSample, PartyType: "customer", PartyID: f.customer,
	})
	if err != nil {
		t.Fatal(err)
	}
	remarks := "已更新"
	remarksValue := &remarks
	updated, err := svc.UpdateHead(ctx, f.actor, SideSales, head.ID,
		UpdateHeadInput{Remarks: &remarksValue})
	if err != nil || updated.Remarks == nil || *updated.Remarks != remarks {
		t.Fatalf("更新头 = %#v err=%v", updated, err)
	}
	item, err := svc.CreateItem(ctx, f.actor, SideSales, CreateItemInput{
		ReconciliationID: head.ID, Idx: 1, Qty: decimal.NewFromInt(1),
		DeliveryItemID: &f.deliveryItem,
	})
	if err != nil {
		t.Fatal(err)
	}
	idx, qty := int64(2), decimal.RequireFromString("1.5")
	item, err = svc.UpdateItem(ctx, f.actor, SideSales, item.ID,
		UpdateItemInput{Idx: &idx, Qty: &qty})
	if err != nil || item.Idx != 2 || !item.Qty.Equal(qty) {
		t.Fatalf("更新行 = %#v err=%v", item, err)
	}
	if err := svc.DeleteItem(ctx, f.actor, SideSales, item.ID); err != nil {
		t.Fatal(err)
	}
	if err := svc.DeleteHead(ctx, f.actor, SideSales, head.ID); err != nil {
		t.Fatal(err)
	}
	foreign := *f.actor
	foreign.CompanyIDs = []uuid.UUID{f.otherCompany}
	list, err := svc.ListHeads(ctx, &foreign, SideSales, ListQuery{})
	if err != nil {
		t.Fatal(err)
	}
	if list.Count != 0 {
		t.Fatalf("公司范围泄漏: %#v", list)
	}
}

func code(err error) apierror.Code {
	if err == nil {
		return ""
	}
	var apiErr *apierror.Error
	if errors.As(err, &apiErr) {
		return apiErr.Code
	}
	return ""
}

func newFixture(t *testing.T) fixture {
	t.Helper()
	url := os.Getenv("SYNIE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("set SYNIE_TEST_DATABASE_URL to run the real PostgreSQL tests")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	f := fixture{
		pool: pool, company: uuid.New(), otherCompany: uuid.New(),
		customer: uuid.New(), supplier: uuid.New(),
		salesDebit: uuid.New(), salesCredit: uuid.New(),
		purchaseDebit: uuid.New(), purchaseCredit: uuid.New(),
		deliveryItem: uuid.New(), receiptItem: uuid.New(),
		outsourcedReceiptItem: uuid.New(),
	}
	f.actor = &authz.Actor{
		Username: "reconciliation-test", CompanyIDs: []uuid.UUID{f.company},
		Permissions: map[string]struct{}{
			"sales.reconciliation:create": {}, "sales.reconciliation:read": {},
			"sales.reconciliation:update": {}, "sales.reconciliation:delete": {},
			"sales.reconciliation:confirm": {}, "sales.reconciliation:unconfirm": {},
			"sales.reconciliation:audit": {}, "sales.reconciliation:void": {},
			"purchase.reconciliation:create": {}, "purchase.reconciliation:read": {},
			"purchase.reconciliation:update": {}, "purchase.reconciliation:delete": {},
			"purchase.reconciliation:confirm": {}, "purchase.reconciliation:unconfirm": {},
			"purchase.reconciliation:audit": {}, "purchase.reconciliation:void": {},
		},
	}
	suffix := f.company.String()
	currency, unit, category, material, warehouse := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	salesOrder, salesOrderItem, delivery := uuid.New(), uuid.New(), uuid.New()
	purchaseOrder, purchaseOrderItem, receipt := uuid.New(), uuid.New(), uuid.New()
	outOrder, outOrderItem, outReceipt := uuid.New(), uuid.New(), uuid.New()
	statements := []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO bas_currency(id,name,iso_code) VALUES($1,$2,$3)`,
			[]any{currency, "测试币" + suffix, "R" + suffix}},
		{`INSERT INTO bas_company(id,code,name,short_name,base_currency_id)
			VALUES($1,$2,$3,$3,$4),($5,$6,$7,$7,$4)`,
			[]any{f.company, "RC" + suffix, "测试公司" + suffix, currency,
				f.otherCompany, "RO" + suffix, "其他公司" + suffix}},
		{`INSERT INTO sal_customers(id,code,name) VALUES($1,$2,$3)`,
			[]any{f.customer, "CU" + suffix, "客户" + suffix}},
		{`INSERT INTO pur_supplier(id,code,name) VALUES($1,$2,$3)`,
			[]any{f.supplier, "SU" + suffix, "供应商" + suffix}},
		{`INSERT INTO bas_account(id,code,name,direction,company_id,role)
			VALUES($1,$5,'销售借','debit',$6,NULL),
			($2,$7,'未开票应收','debit',$6,'unbilled_receivable'),
			($3,$8,'未开票应付','credit',$6,'unbilled_payable'),
			($4,$9,'采购贷','credit',$6,NULL)`,
			[]any{f.salesDebit, f.salesCredit, f.purchaseDebit, f.purchaseCredit,
				"A" + suffix, f.company, "B" + suffix, "C" + suffix, "D" + suffix}},
		{`INSERT INTO sal_company_account_default(company_id,delivery_debit_account_id,
			delivery_credit_account_id,receipt_debit_account_id,receipt_credit_account_id)
			VALUES($1,$2,$3,$4,$5)`,
			[]any{f.company, f.salesCredit, f.salesDebit, f.purchaseCredit, f.purchaseDebit}},
		{`INSERT INTO bas_unit(id,unit_type,is_base,name,symbol,ratio)
			VALUES($1,'quantity',false,$2,$3,1)`, []any{unit, "件" + suffix, "u" + suffix}},
		{`INSERT INTO inv_material_category(id,code,name) VALUES($1,$2,$3)`,
			[]any{category, "MC" + suffix, "分类" + suffix}},
		{`INSERT INTO inv_material(id,code,name,category_id,default_unit_id)
			VALUES($1,$2,$3,$4,$5)`, []any{material, "M" + suffix, "物料" + suffix, category, unit}},
		{`INSERT INTO inv_warehouse(id,name,company_id) VALUES($1,$2,$3)`,
			[]any{warehouse, "仓" + suffix, f.company}},
		{`INSERT INTO sal_order(id,order_no,party_type,party_id,status,company_id,
			exchange_rate,currency_id,order_type) VALUES($1,$2,'customer',$3,'audited',$4,1.2,$5,'regular')`,
			[]any{salesOrder, "SO" + suffix, f.customer, f.company, currency}},
		{`INSERT INTO sal_order_item(id,idx,qty,price,amount,order_id,company_id,
			material_id,unit_id,material_code,material_name,unit_name,base_qty)
			VALUES($1,1,10,10,100,$2,$3,$4,$5,$6,$7,$8,20)`,
			[]any{salesOrderItem, salesOrder, f.company, material, unit, "M" + suffix, "物料" + suffix, "件"}},
		{`INSERT INTO sal_delivery(id,delivery_no,party_type,party_id,status,company_id,
			warehouse_id,debit_account_id,credit_account_id)
			VALUES($1,$2,'customer',$3,'audited',$4,$5,$6,$7)`,
			[]any{delivery, "SD" + suffix, f.customer, f.company, warehouse, f.salesCredit, f.salesDebit}},
		{`INSERT INTO sal_delivery_item(id,idx,qty,base_qty,material_code,material_name,
			unit_name,order_no,order_qty,order_base_qty,order_unit_name,order_price,
			order_amount,order_base_price,order_base_amount,order_tax_rate,order_currency_code,
			delivery_id,company_id,order_item_id,material_id,unit_id,warehouse_id)
			VALUES($1,1,10,20,$2,$3,'件',$4,10,20,'件',10,100,12,120,.13,$5,
			$6,$7,$8,$9,$10,$11)`,
			[]any{f.deliveryItem, "M" + suffix, "物料" + suffix, "SO" + suffix, "R" + suffix,
				delivery, f.company, salesOrderItem, material, unit, warehouse}},
		{`INSERT INTO pur_order(id,order_no,party_type,party_id,status,company_id,
			exchange_rate,currency_id) VALUES($1,$2,'supplier',$3,'audited',$4,1.2,$5)`,
			[]any{purchaseOrder, "PO" + suffix, f.supplier, f.company, currency}},
		{`INSERT INTO pur_order_item(id,idx,qty,base_qty,price,amount,order_id,company_id,
			material_id,unit_id,material_code,material_name,unit_name)
			VALUES($1,1,10,10,8,80,$2,$3,$4,$5,$6,$7,'件')`,
			[]any{purchaseOrderItem, purchaseOrder, f.company, material, unit, "M" + suffix, "物料" + suffix}},
		{`INSERT INTO pur_receipt(id,receipt_no,party_type,party_id,status,company_id,
			warehouse_id,debit_account_id,credit_account_id)
			VALUES($1,$2,'supplier',$3,'audited',$4,$5,$6,$7)`,
			[]any{receipt, "PR" + suffix, f.supplier, f.company, warehouse, f.purchaseCredit, f.purchaseDebit}},
		{`INSERT INTO pur_receipt_item(id,idx,qty,base_qty,material_code,material_name,
			unit_name,order_no,order_qty,order_base_qty,order_unit_name,order_price,
			order_amount,order_base_price,order_base_amount,order_tax_rate,order_currency_code,
			receipt_id,company_id,order_item_id,material_id,unit_id,warehouse_id)
			VALUES($1,1,10,10,$2,$3,'件',$4,10,10,'件',8,80,9.6,96,.13,$5,
			$6,$7,$8,$9,$10,$11)`,
			[]any{f.receiptItem, "M" + suffix, "物料" + suffix, "PO" + suffix, "R" + suffix,
				receipt, f.company, purchaseOrderItem, material, unit, warehouse}},
		{`INSERT INTO pur_order(id,order_no,party_type,party_id,status,company_id,
			exchange_rate,currency_id,is_outsourced) VALUES($1,$2,'supplier',$3,'audited',$4,1.2,$5,true)`,
			[]any{outOrder, "OO" + suffix, f.supplier, f.company, currency}},
		{`INSERT INTO pur_order_item(id,idx,qty,base_qty,price,amount,order_id,company_id,
			material_id,unit_id,material_code,material_name,unit_name)
			VALUES($1,1,10,10,8,80,$2,$3,$4,$5,$6,$7,'件')`,
			[]any{outOrderItem, outOrder, f.company, material, unit, "M" + suffix, "物料" + suffix}},
		{`INSERT INTO pur_outsourced_receipt(id,receipt_no,party_type,party_id,status,
			company_id,warehouse_id,debit_account_id,credit_account_id)
			VALUES($1,$2,'supplier',$3,'audited',$4,$5,$6,$7)`,
			[]any{outReceipt, "OR" + suffix, f.supplier, f.company, warehouse, f.purchaseCredit, f.purchaseDebit}},
		{`INSERT INTO pur_outsourced_receipt_item(id,idx,qty,base_qty,material_code,
			material_name,unit_name,order_no,order_qty,order_base_qty,order_unit_name,
			order_price,order_amount,order_base_price,order_base_amount,order_tax_rate,
			order_currency_code,receipt_id,company_id,order_item_id,material_id,unit_id,warehouse_id)
			VALUES($1,1,10,10,$2,$3,'件',$4,10,10,'件',8,80,9.6,96,.13,$5,
			$6,$7,$8,$9,$10,$11)`,
			[]any{f.outsourcedReceiptItem, "M" + suffix, "物料" + suffix, "OO" + suffix,
				"R" + suffix, outReceipt, f.company, outOrderItem, material, unit, warehouse}},
	}
	for _, statement := range statements {
		if _, err := pool.Exec(ctx, statement.sql, statement.args...); err != nil {
			pool.Close()
			t.Fatalf("seed fixture: %v\n%s", err, statement.sql)
		}
	}
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		execCleanup := func(query string, args ...any) {
			if _, err := pool.Exec(cleanupCtx, query, args...); err != nil {
				t.Errorf("cleanup reconciliation fixture: %v\n%s", err, query)
			}
		}
		execCleanup(`DELETE FROM sys_todo WHERE company_id=$1`, f.company)
		execCleanup(`DELETE FROM sys_audit_log WHERE company_id=$1`, f.company)
		execCleanup(`DELETE FROM sal_reconciliation WHERE company_id=$1`, f.company)
		execCleanup(`DELETE FROM pur_reconciliation WHERE company_id=$1`, f.company)
		execCleanup(`DELETE FROM acc_gl_entry WHERE company_id=$1`, f.company)
		execCleanup(`DELETE FROM sal_company_account_default WHERE company_id=$1`, f.company)
		for _, statement := range []struct {
			sql string
			arg any
		}{
			{`DELETE FROM sal_delivery WHERE id=$1`, delivery},
			{`DELETE FROM pur_receipt WHERE id=$1`, receipt},
			{`DELETE FROM pur_outsourced_receipt WHERE id=$1`, outReceipt},
			{`DELETE FROM sal_order WHERE id=$1`, salesOrder},
			{`DELETE FROM pur_order WHERE id=$1`, purchaseOrder},
			{`DELETE FROM pur_order WHERE id=$1`, outOrder},
			{`DELETE FROM inv_warehouse WHERE id=$1`, warehouse},
			{`DELETE FROM inv_material WHERE id=$1`, material},
			{`DELETE FROM inv_material_category WHERE id=$1`, category},
			{`DELETE FROM bas_account WHERE company_id=$1`, f.company},
			{`DELETE FROM sal_customers WHERE id=$1`, f.customer},
			{`DELETE FROM pur_supplier WHERE id=$1`, f.supplier},
		} {
			execCleanup(statement.sql, statement.arg)
		}
		execCleanup(`DELETE FROM bas_company WHERE id=ANY($1::uuid[])`,
			[]uuid.UUID{f.company, f.otherCompany})
		execCleanup(`DELETE FROM bas_currency WHERE id=$1`, currency)
		// 单位行与其他模块真实 PostgreSQL 测试共用表，放到公司主数据清理之后，
		// 避免它一旦等待锁就让后续公司/科目夹具全部错过收口。
		execCleanup(`DELETE FROM bas_unit WHERE id=$1`, unit)
	})
	return f
}
