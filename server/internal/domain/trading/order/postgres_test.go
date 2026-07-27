package order

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/domain/trading/quotation"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/platform/numbering"
	"github.com/z1coyan/synie/server/internal/testutil"
)

type orderNumberer struct{ value string }

func (n orderNumberer) NextInTx(context.Context, pgx.Tx, numbering.NextInput) (string, error) {
	return n.value, nil
}

type orderFixture struct {
	pool                                 *pgxpool.Pool
	companyID, otherCompanyID, userID    uuid.UUID
	currencyID, customerID, supplierID   uuid.UUID
	categoryID, unitID, boxID, badUnitID uuid.UUID
	materialID, customerMaterialID       uuid.UUID
	demandID, demandLineID, bomID        uuid.UUID
	suffix                               string
}

func TestPostgresOrderSalesPricingLifecycleConcurrencyAndScope(t *testing.T) {
	f := newOrderFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()
	actor := orderActor(f)
	qsvc := quotation.NewService(f.pool)
	today := time.Date(2026, 7, 26, 0, 0, 0, 0, time.UTC)
	quote, err := qsvc.CreateQuotation(ctx, actor, quotation.SideSales, quotation.CreateQuotationInput{
		CompanyID: f.companyID, QuotationNo: stringPointer("SQ-" + f.suffix),
		QuotationDate: &today, ValidUntil: today.AddDate(0, 1, 0),
		PartyType: "CUSTOMER", PartyID: f.customerID,
	})
	if err != nil {
		t.Fatal(err)
	}
	price := decimal.RequireFromString("12.50")
	quoteItem, err := qsvc.CreateItem(ctx, actor, quotation.SideSales, quotation.CreateItemInput{
		QuotationID: quote.ID, Idx: 1, MaterialID: f.materialID, UnitID: f.boxID,
		PricingMode: quotation.PricingFixed, Price: &price,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := qsvc.AuditQuotation(ctx, actor, quotation.SideSales, quote.ID); err != nil {
		t.Fatal(err)
	}
	svc := NewService(f.pool, orderNumberer{value: "SO-" + f.suffix})
	head, err := svc.CreateOrder(ctx, actor, SideSales, CreateOrderInput{
		CompanyID: f.companyID, OrderDate: &today, OrderType: OrderTypeRegular,
		PartyType: "CUSTOMER", PartyID: f.customerID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if head.OrderNo != "SO-"+f.suffix || head.Status != StatusDraft ||
		!head.ExchangeRate.Equal(decimal.NewFromInt(1)) {
		t.Fatalf("created sales order = %#v", head)
	}
	qty := decimal.NewFromInt(20)
	item, err := svc.CreateItem(ctx, actor, SideSales, CreateItemInput{
		OrderID: head.ID, Idx: 1, Qty: qty, MaterialID: f.customerMaterialID,
		UnitID: f.badUnitID, QuotationItemID: &quoteItem.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if item.MaterialID != f.materialID || item.UnitID != f.boxID ||
		!item.Price.Equal(price) || !item.BaseQty.Equal(decimal.NewFromInt(2)) ||
		!item.Amount.Equal(decimal.NewFromInt(250)) || item.PricingMode == nil ||
		*item.PricingMode != "FIXED" {
		t.Fatalf("derived sales item = %#v", item)
	}
	type auditResult struct {
		item Order
		err  error
	}
	start := make(chan struct{})
	results := make(chan auditResult, 2)
	var wg sync.WaitGroup
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			got, auditErr := svc.AuditOrder(ctx, actor, SideSales, head.ID)
			results <- auditResult{item: got, err: auditErr}
		}()
	}
	close(start)
	wg.Wait()
	close(results)
	successes, conflicts := 0, 0
	for result := range results {
		switch orderErrorCode(result.err) {
		case "":
			successes++
			head = result.item
		case apierror.CodeConflict:
			conflicts++
		default:
			t.Fatalf("unexpected concurrent audit error: %v", result.err)
		}
	}
	if successes != 1 || conflicts != 1 || head.Status != StatusAudited {
		t.Fatalf("concurrent audit successes=%d conflicts=%d head=%#v", successes, conflicts, head)
	}
	var auditCount int
	if err := f.pool.QueryRow(ctx, `SELECT count(*) FROM sys_audit_log
		WHERE resource='sal_order' AND record_id=$1 AND action_name='audit'`, head.ID).Scan(&auditCount); err != nil {
		t.Fatal(err)
	}
	if auditCount != 1 {
		t.Fatalf("audit count = %d", auditCount)
	}
	emptyScope := &authz.Actor{Permissions: map[string]struct{}{"sales.order:*": {}}}
	list, err := svc.ListItems(ctx, emptyScope, SideSales, ListQuery{Limit: 20})
	if err != nil {
		t.Fatal(err)
	}
	if list.Count != 0 {
		t.Fatalf("empty scope items = %#v", list)
	}
	if _, err := svc.UpdateItem(ctx, actor, SideSales, item.ID, UpdateItemInput{Qty: &qty}); orderErrorCode(err) != apierror.CodeConflict {
		t.Fatalf("audited item update error = %#v", err)
	}
	if head, err = svc.CloseOrder(ctx, actor, SideSales, head.ID); err != nil || head.Status != StatusClosed {
		t.Fatalf("close sales order = %#v err=%v", head, err)
	}

	sample, err := svc.CreateOrder(ctx, actor, SideSales, CreateOrderInput{
		CompanyID: f.companyID, OrderNo: stringPointer("SS-" + f.suffix), OrderDate: &today,
		OrderType: OrderTypeSample, PartyType: "COMPANY", PartyID: f.otherCompanyID,
	})
	if err != nil {
		t.Fatal(err)
	}
	zero := decimal.Zero
	if _, err := svc.CreateItem(ctx, actor, SideSales, CreateItemInput{
		OrderID: sample.ID, Idx: 1, Qty: decimal.NewFromInt(1), MaterialID: f.customerMaterialID,
		UnitID: f.unitID, Price: &zero,
	}); orderErrorCode(err) != apierror.CodeValidation {
		t.Fatalf("internal-company customer material error = %#v", err)
	}
}

func TestPostgresOrderPurchaseDemandOutsourcingAndRollback(t *testing.T) {
	f := newOrderFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()
	actor := orderActor(f)
	svc := NewService(f.pool)
	today := time.Date(2026, 7, 26, 0, 0, 0, 0, time.UTC)
	create := func(no string) (Order, Item) {
		head, err := svc.CreateOrder(ctx, actor, SidePurchase, CreateOrderInput{
			CompanyID: f.companyID, OrderNo: &no, OrderDate: &today, OrderType: OrderTypeSpot,
			IsOutsourced: true, PartyType: "SUPPLIER", PartyID: f.supplierID,
		})
		if err != nil {
			t.Fatal(err)
		}
		price := decimal.NewFromInt(3)
		item, err := svc.CreateItem(ctx, actor, SidePurchase, CreateItemInput{
			OrderID: head.ID, Idx: 1, Qty: decimal.NewFromInt(5), MaterialID: f.materialID,
			UnitID: f.unitID, Price: &price, DemandLineID: &f.demandLineID, DemandDate: &today,
			BOMID: &f.bomID,
		})
		if err != nil {
			t.Fatal(err)
		}
		if item.BOMCode == nil || item.DemandNo == nil {
			t.Fatalf("purchase item display sources = %#v", item)
		}
		return head, item
	}
	first, firstItem := create("PO-A-" + f.suffix)
	second, _ := create("PO-B-" + f.suffix)
	material, err := svc.CreateMaterial(ctx, actor, CreateMaterialInput{
		OrderItemID: firstItem.ID, MaterialID: f.materialID, UnitID: f.unitID,
		Quantity: decimal.NewFromInt(2),
	})
	if err != nil || material.IssuedQty.Sign() != 0 {
		t.Fatalf("create material = %#v err=%v", material, err)
	}
	if _, err := svc.CreateByproduct(ctx, actor, CreateByproductInput{
		OrderItemID: firstItem.ID, MaterialID: f.customerMaterialID, UnitID: f.unitID,
		Quantity: decimal.NewFromInt(1),
	}); err != nil {
		t.Fatal(err)
	}
	preview, err := svc.PreviewBOM(ctx, actor, f.bomID, decimal.NewFromInt(5))
	if err != nil {
		t.Fatal(err)
	}
	if len(preview.Materials) != 1 || len(preview.Byproducts) != 1 ||
		preview.Materials[0].MaterialCode == "" ||
		!preview.Materials[0].Quantity.Equal(decimal.RequireFromString("5.5")) {
		t.Fatalf("BOM preview = %#v", preview)
	}
	start := make(chan struct{})
	type result struct {
		order Order
		err   error
	}
	results := make(chan result, 2)
	var wg sync.WaitGroup
	for _, orderID := range []uuid.UUID{first.ID, second.ID} {
		wg.Add(1)
		go func(id uuid.UUID) {
			defer wg.Done()
			<-start
			item, auditErr := svc.AuditOrder(ctx, actor, SidePurchase, id)
			results <- result{order: item, err: auditErr}
		}(orderID)
	}
	close(start)
	wg.Wait()
	close(results)
	var audited Order
	successes, conflicts := 0, 0
	for result := range results {
		switch orderErrorCode(result.err) {
		case "":
			successes++
			audited = result.order
		case apierror.CodeConflict:
			conflicts++
		default:
			t.Fatalf("unexpected purchase audit error: %v", result.err)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("demand race successes=%d conflicts=%d", successes, conflicts)
	}
	var ordered decimal.Decimal
	if err := f.pool.QueryRow(ctx, `SELECT ordered_qty FROM mfg_demand_item WHERE id=$1`,
		f.demandLineID).Scan(&ordered); err != nil {
		t.Fatal(err)
	}
	if !ordered.Equal(decimal.NewFromInt(5)) {
		t.Fatalf("ordered projection after audit = %s", ordered)
	}
	if _, err := svc.VoidOrder(ctx, actor, SidePurchase, audited.ID); err != nil {
		t.Fatal(err)
	}
	if err := f.pool.QueryRow(ctx, `SELECT ordered_qty FROM mfg_demand_item WHERE id=$1`,
		f.demandLineID).Scan(&ordered); err != nil {
		t.Fatal(err)
	}
	if !ordered.IsZero() {
		t.Fatalf("ordered projection after void = %s", ordered)
	}
}

func newOrderFixture(t *testing.T) orderFixture {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pool := testutil.NewPool(t, ctx)
	suffix := strings.ReplaceAll(uuid.NewString(), "-", "")[:12]
	f := orderFixture{
		pool: pool, companyID: uuid.New(), otherCompanyID: uuid.New(), userID: uuid.New(),
		currencyID: uuid.New(), customerID: uuid.New(), supplierID: uuid.New(),
		categoryID: uuid.New(), unitID: uuid.New(), boxID: uuid.New(), badUnitID: uuid.New(),
		materialID: uuid.New(), customerMaterialID: uuid.New(), demandID: uuid.New(),
		demandLineID: uuid.New(), bomID: uuid.New(), suffix: suffix,
	}
	batch := &pgx.Batch{}
	batch.Queue(`INSERT INTO bas_currency(id,name,iso_code,active) VALUES($1,$2,$3,true)`,
		f.currencyID, "订单币-"+suffix, "O"+suffix)
	batch.Queue(`INSERT INTO bas_company(id,code,name,short_name,base_currency_id)
		VALUES($1,$2,$3,$3,$4),($5,$6,$7,$7,$4)`,
		f.companyID, "O"+suffix, "订单公司-"+suffix, f.currencyID,
		f.otherCompanyID, "X"+suffix, "订单内部公司-"+suffix)
	batch.Queue(`INSERT INTO sys_user(id,username,name,hashed_password,super_admin,all_companies)
		VALUES($1,$2,$3,'test',false,false)`,
		f.userID, "order-"+suffix, "订单用户-"+suffix)
	batch.Queue(`INSERT INTO sal_customers(id,code,name) VALUES($1,$2,$3)`,
		f.customerID, "C"+suffix, "订单客户-"+suffix)
	batch.Queue(`INSERT INTO pur_supplier(id,code,name) VALUES($1,$2,$3)`,
		f.supplierID, "S"+suffix, "订单供应商-"+suffix)
	batch.Queue(`INSERT INTO bas_unit(id,unit_type,is_base,name,symbol,ratio) VALUES
		($1,$10,true,$2,$3,1),($4,$10,false,$5,$6,10),
		($7,$10,false,$8,$9,1)`,
		f.unitID, "订单个-"+suffix, "EA"+suffix,
		f.boxID, "订单箱-"+suffix, "BOX"+suffix,
		f.badUnitID, "错误单位-"+suffix, "BAD"+suffix, "order-"+suffix)
	batch.Queue(`INSERT INTO inv_material_category(id,code,name,is_leaf,active)
		VALUES($1,$2,$3,true,true)`, f.categoryID, "MC"+suffix, "订单分类-"+suffix)
	batch.Queue(`INSERT INTO inv_material(
		id,code,name,spec,category_id,default_unit_id,is_customer_material,customer_id
	) VALUES($1,$2,$3,$4,$5,$6,false,NULL),
		($7,$8,$9,$10,$5,$6,true,$11)`,
		f.materialID, "M"+suffix, "订单物料-"+suffix, "SPEC-"+suffix, f.categoryID, f.unitID,
		f.customerMaterialID, "CM"+suffix, "订单客户料-"+suffix, "CSPEC-"+suffix, f.customerID)
	batch.Queue(`INSERT INTO inv_material_unit(material_id,unit_id,factor) VALUES($1,$2,10)`,
		f.materialID, f.boxID)
	batch.Queue(`INSERT INTO mfg_bom(id,code,plan_name,material_id)
		VALUES($1,$2,$3,$4)`, f.bomID, "BOM-"+suffix, "订单测试方案", f.materialID)
	batch.Queue(`INSERT INTO mfg_bom_component(
		bom_id,material_id,unit_id,quantity,loss_rate,note)
		VALUES($1,$2,$3,1,0.1,'发料')`, f.bomID, f.materialID, f.unitID)
	batch.Queue(`INSERT INTO mfg_bom_byproduct(
		bom_id,material_id,unit_id,quantity,note)
		VALUES($1,$2,$3,0.2,'副产物')`, f.bomID, f.customerMaterialID, f.unitID)
	batch.Queue(`INSERT INTO mfg_demand(
		id,demand_no,demand_date,status,company_id,created_by_id)
		VALUES($1,$2,CURRENT_DATE,'confirmed',$3,$4)`,
		f.demandID, "D-"+suffix, f.companyID, f.userID)
	batch.Queue(`INSERT INTO mfg_demand_item(
		id,idx,qty,base_qty,need_date,fulfillment_method,status,material_code,material_name,
		unit_name,demand_id,company_id,material_id,unit_id,ordered_qty,received_qty)
		VALUES($1,1,5,5,CURRENT_DATE,'outsource','pending',$2,$3,$4,$5,$6,$7,$8,0,0)`,
		f.demandLineID, "M"+suffix, "订单物料-"+suffix, "订单个-"+suffix,
		f.demandID, f.companyID, f.materialID, f.unitID)
	results := pool.SendBatch(ctx, batch)
	if err := results.Close(); err != nil {
		pool.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cleanupCancel()
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM sys_attachment WHERE company_id=$1", f.companyID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM sys_audit_log WHERE company_id=$1", f.companyID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM sal_order WHERE company_id=$1", f.companyID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM pur_order WHERE company_id=$1", f.companyID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM sal_quotation WHERE company_id=$1", f.companyID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM pur_quotation WHERE company_id=$1", f.companyID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM mfg_demand WHERE id=$1", f.demandID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM mfg_bom WHERE id=$1", f.bomID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM inv_material_unit WHERE material_id=$1", f.materialID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM inv_material WHERE id=ANY($1::uuid[])",
			[]uuid.UUID{f.materialID, f.customerMaterialID})
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM inv_material_category WHERE id=$1", f.categoryID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM bas_unit WHERE id=ANY($1::uuid[])",
			[]uuid.UUID{f.unitID, f.boxID, f.badUnitID})
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM pur_supplier WHERE id=$1", f.supplierID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM sal_customers WHERE id=$1", f.customerID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM sys_user WHERE id=$1", f.userID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM bas_company WHERE id=ANY($1::uuid[])",
			[]uuid.UUID{f.companyID, f.otherCompanyID})
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM bas_currency WHERE id=$1", f.currencyID)
		pool.Close()
	})
	return f
}

func orderActor(f orderFixture) *authz.Actor {
	return &authz.Actor{
		UserID: f.userID, Username: "order-test", CompanyIDs: []uuid.UUID{f.companyID},
		Permissions: map[string]struct{}{
			"sales.order:*": {}, "purchase.order:*": {},
			"sales.quotation:*": {}, "purchase.quotation:*": {},
		},
	}
}

func orderErrorCode(err error) apierror.Code {
	var target *apierror.Error
	if errors.As(err, &target) {
		return target.Code
	}
	return ""
}

func stringPointer(value string) *string { return &value }
