package standard

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/domain/inventory/stock"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/platform/numbering"
	"github.com/z1coyan/synie/server/internal/testutil"
)

type standardNumberer struct {
	mu     sync.Mutex
	suffix string
	inputs []numbering.NextInput
}

func (n *standardNumberer) NextInTx(
	_ context.Context, _ pgx.Tx, input numbering.NextInput,
) (string, error) {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.inputs = append(n.inputs, input)
	return "AUTO-" + strings.ToUpper(strings.ReplaceAll(input.Resource, ".", "-")) + "-" + n.suffix, nil
}

type standardPGFixture struct {
	pool                                  *pgxpool.Pool
	companyID, otherCompanyID, userID     uuid.UUID
	baseCurrencyID, foreignCurrencyID     uuid.UUID
	customerID, supplierID                uuid.UUID
	unitID, boxID, unrelatedUnitID        uuid.UUID
	categoryID, materialID                uuid.UUID
	warehouseID, emptyWarehouseID         uuid.UUID
	negativeWarehouseID, groupWarehouseID uuid.UUID
	salesDebitID, salesCreditID           uuid.UUID
	purchaseDebitID, purchaseCreditID     uuid.UUID
	wrongRoleID, disabledAccountID        uuid.UUID
	fileOneID, fileTwoID                  uuid.UUID
	demandID, demandLineID                uuid.UUID
	suffix                                string
}

type standardOrderSeed struct {
	side         Side
	status       string
	currencyID   uuid.UUID
	qty          decimal.Decimal
	baseQty      decimal.Decimal
	price        decimal.Decimal
	amount       decimal.Decimal
	basePrice    decimal.Decimal
	baseAmount   decimal.Decimal
	taxRate      decimal.Decimal
	demandLineID *uuid.UUID
	// materialID 为空时回落夹具物料；双物料场景（如装箱漏装）显式指定。
	materialID uuid.UUID
}

func TestPostgresStandardHeadItemSourceUnitsCurrencyAndDrawings(t *testing.T) {
	f := newStandardPGFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()
	actor := standardActor(f)
	numberer := &standardNumberer{suffix: f.suffix}
	svc := NewService(f.pool, numberer)

	head, err := svc.CreateHead(ctx, actor, SideSales, CreateHeadInput{
		CompanyID: f.companyID, PartyType: " CUSTOMER ", PartyID: f.customerID,
		WarehouseID: &f.warehouseID, DebitAccountID: f.salesDebitID,
		CreditAccountID: f.salesCreditID,
	})
	if err != nil {
		t.Fatal(err)
	}
	wantToday := todayUTC()
	if head.No != "AUTO-SALES-DELIVERY-"+f.suffix ||
		!head.DocumentDate.Equal(wantToday) || head.Status != StatusDraft ||
		head.CreatedByID == nil || *head.CreatedByID != f.userID {
		t.Fatalf("自动编号/默认日期/创建人 = %#v", head)
	}
	numberer.mu.Lock()
	if len(numberer.inputs) != 1 ||
		numberer.inputs[0].Resource != "sales.delivery" ||
		numberer.inputs[0].Values["company_id"] != f.companyID ||
		numberer.inputs[0].Values["document_date"] != wantToday {
		t.Fatalf("编号输入 = %#v", numberer.inputs)
	}
	numberer.mu.Unlock()

	explicit := "  MANUAL-" + f.suffix + "  "
	purchase, err := svc.CreateHead(ctx, actor, SidePurchase, CreateHeadInput{
		CompanyID: f.companyID, No: &explicit, PartyType: "SUPPLIER", PartyID: f.supplierID,
		DebitAccountID: f.purchaseDebitID, CreditAccountID: f.purchaseCreditID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if purchase.No != "MANUAL-"+f.suffix || !purchase.DocumentDate.Equal(wantToday) {
		t.Fatalf("手填编号/默认日期 = %#v", purchase)
	}

	assertCreateHeadCode(t, svc, ctx, actor, SideSales, f, "EMPLOYEE", f.customerID,
		&f.warehouseID, f.salesDebitID, f.salesCreditID, apierror.CodeValidation)
	assertCreateHeadCode(t, svc, ctx, actor, SideSales, f, "CUSTOMER", uuid.New(),
		&f.warehouseID, f.salesDebitID, f.salesCreditID, apierror.CodeValidation)
	assertCreateHeadCode(t, svc, ctx, actor, SideSales, f, "CUSTOMER", f.customerID,
		&f.groupWarehouseID, f.salesDebitID, f.salesCreditID, apierror.CodeValidation)
	assertCreateHeadCode(t, svc, ctx, actor, SideSales, f, "CUSTOMER", f.customerID,
		&f.warehouseID, f.wrongRoleID, f.salesCreditID, apierror.CodeValidation)
	assertCreateHeadCode(t, svc, ctx, actor, SidePurchase, f, "SUPPLIER", f.supplierID,
		&f.warehouseID, f.purchaseDebitID, f.wrongRoleID, apierror.CodeValidation)
	assertCreateHeadCode(t, svc, ctx, actor, SidePurchase, f, "SUPPLIER", f.supplierID,
		&f.warehouseID, f.purchaseDebitID, f.disabledAccountID, apierror.CodeValidation)

	salesOrderID, salesOrderItemID := insertStandardOrder(t, ctx, f, standardOrderSeed{
		side: SideSales, status: "audited", currencyID: f.baseCurrencyID,
		qty: decimal.NewFromInt(20), baseQty: decimal.NewFromInt(2),
		price: decimal.NewFromInt(12), amount: decimal.NewFromInt(240),
		basePrice: decimal.NewFromInt(120), baseAmount: decimal.NewFromInt(240),
		taxRate: decimal.RequireFromString("0.13"),
	})
	item, err := svc.CreateItem(ctx, actor, SideSales, CreateItemInput{
		HeadID: head.ID, Idx: -7, Qty: decimal.NewFromInt(20),
		OrderItemID: salesOrderItemID, UnitID: &f.boxID, WarehouseID: f.warehouseID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if item.CompanyID != f.companyID || item.MaterialID != f.materialID ||
		item.UnitID != f.boxID || item.UnitName != "履约箱-"+f.suffix ||
		!item.BaseQty.Equal(decimal.NewFromInt(2)) ||
		item.MaterialCode != "M"+f.suffix || item.MaterialName != "履约物料-"+f.suffix ||
		item.OrderNo != "SO-"+salesOrderID.String() ||
		!item.OrderAmount.Equal(decimal.NewFromInt(240)) ||
		item.OrderCurrencyCode != "CNY"+f.suffix {
		t.Fatalf("来源/单位折算/快照 = %#v", item)
	}
	requireDrawingFiles(t, ctx, f.pool, "sal_delivery_item", item.ID, []uuid.UUID{f.fileOneID})
	regularCandidates, err := svc.ListItems(ctx, actor, SideSales, ListQuery{
		Limit: 20,
		Filter: map[string]json.RawMessage{
			"orderType": json.RawMessage(`{"kind":"enum","values":["REGULAR"]}`),
		},
	})
	if err != nil || regularCandidates.Count != 1 ||
		len(regularCandidates.Results) != 1 || regularCandidates.Results[0].ID != item.ID {
		t.Fatalf("常规订单来源候选筛选 = %#v err=%v", regularCandidates, err)
	}
	if _, err := f.pool.Exec(ctx, `UPDATE sal_order SET order_type='sample' WHERE id=$1`,
		salesOrderID); err != nil {
		t.Fatal(err)
	}
	regularCandidates, err = svc.ListItems(ctx, actor, SideSales, ListQuery{
		Limit: 20,
		Filter: map[string]json.RawMessage{
			"orderType": json.RawMessage(`{"kind":"enum","values":["REGULAR"]}`),
		},
	})
	if err != nil || regularCandidates.Count != 0 {
		t.Fatalf("常规对账候选不得包含样品订单来源 = %#v err=%v", regularCandidates, err)
	}
	if _, err := f.pool.Exec(ctx, `UPDATE sal_order SET order_type='regular' WHERE id=$1`,
		salesOrderID); err != nil {
		t.Fatal(err)
	}

	if _, err := f.pool.Exec(ctx, `DELETE FROM sys_attachment
		WHERE owner_type='inv_material' AND owner_id=$1 AND category='drawing'`, f.materialID); err != nil {
		t.Fatal(err)
	}
	requireDrawingFiles(t, ctx, f.pool, "sal_delivery_item", item.ID, []uuid.UUID{f.fileOneID})
	if _, err := f.pool.Exec(ctx, `INSERT INTO sys_attachment(
		owner_type,owner_id,category,file_id,company_id)
		VALUES('inv_material',$1,'drawing',$2,$3)`,
		f.materialID, f.fileTwoID, f.companyID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(ctx, `UPDATE inv_material SET code=$2,name=$3,spec=$4,
		customer_part_no=$5 WHERE id=$1`,
		f.materialID, "M2"+f.suffix, "新物料-"+f.suffix, "SPEC2-"+f.suffix, "PART2-"+f.suffix); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(ctx, `UPDATE sal_order_item SET amount=360,base_amount=360,
		price=18,base_price=180 WHERE id=$1`, salesOrderItemID); err != nil {
		t.Fatal(err)
	}
	qty := decimal.NewFromInt(30)
	item, err = svc.UpdateItem(ctx, actor, SideSales, item.ID, UpdateItemInput{Qty: &qty})
	if err != nil {
		t.Fatal(err)
	}
	if !item.BaseQty.Equal(decimal.NewFromInt(3)) ||
		item.MaterialCode != "M2"+f.suffix || item.MaterialName != "新物料-"+f.suffix ||
		item.MaterialSpec == nil || *item.MaterialSpec != "SPEC2-"+f.suffix ||
		item.CustomerPartNo == nil || *item.CustomerPartNo != "PART2-"+f.suffix ||
		!item.OrderAmount.Equal(decimal.NewFromInt(360)) {
		t.Fatalf("更新重拍快照 = %#v", item)
	}
	requireDrawingFiles(t, ctx, f.pool, "sal_delivery_item", item.ID, []uuid.UUID{f.fileTwoID})

	_, foreignItemID := insertStandardOrder(t, ctx, f, standardOrderSeed{
		side: SideSales, status: "audited", currencyID: f.foreignCurrencyID,
		qty: decimal.NewFromInt(1), baseQty: decimal.NewFromInt(1),
		price: decimal.NewFromInt(1), amount: decimal.NewFromInt(1),
		basePrice: decimal.NewFromInt(1), baseAmount: decimal.NewFromInt(1),
		taxRate: decimal.RequireFromString("0.13"),
	})
	if _, err := svc.CreateItem(ctx, actor, SideSales, CreateItemInput{
		HeadID: head.ID, Idx: 2, Qty: decimal.NewFromInt(1), OrderItemID: foreignItemID,
		WarehouseID: f.warehouseID,
	}); standardErrorCode(err) != apierror.CodeValidation {
		t.Fatalf("同单不同原币 error = %#v", err)
	}
	_, draftItemID := insertStandardOrder(t, ctx, f, standardOrderSeed{
		side: SideSales, status: "draft", currencyID: f.baseCurrencyID,
		qty: decimal.NewFromInt(1), baseQty: decimal.NewFromInt(1),
		price: decimal.NewFromInt(1), amount: decimal.NewFromInt(1),
		basePrice: decimal.NewFromInt(1), baseAmount: decimal.NewFromInt(1),
		taxRate: decimal.RequireFromString("0.13"),
	})
	if _, err := svc.CreateItem(ctx, actor, SideSales, CreateItemInput{
		HeadID: head.ID, Idx: 3, Qty: decimal.NewFromInt(1), OrderItemID: draftItemID,
		WarehouseID: f.warehouseID,
	}); standardErrorCode(err) != apierror.CodeValidation {
		t.Fatalf("草稿订单来源 error = %#v", err)
	}
	if _, err := svc.CreateItem(ctx, actor, SideSales, CreateItemInput{
		HeadID: head.ID, Idx: 4, Qty: decimal.NewFromInt(1), OrderItemID: salesOrderItemID,
		WarehouseID: uuid.Nil,
	}); standardErrorCode(err) != apierror.CodeValidation {
		t.Fatalf("头默认仓不应补行仓 error = %#v", err)
	}
	newParty := f.otherCompanyID
	newType := "COMPANY"
	if _, err := svc.UpdateHead(ctx, actor, SideSales, head.ID, UpdateHeadInput{
		PartyType: &newType, PartyID: &newParty,
	}); standardErrorCode(err) != apierror.CodeConflict {
		t.Fatalf("有行冻结对手 error = %#v", err)
	}
}

func TestPostgresStandardSalesAuditVoidZeroAmountAndNegativeRollback(t *testing.T) {
	f := newStandardPGFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	actor := standardActor(f)
	svc := NewService(f.pool)
	documentDate := time.Date(2026, 7, 20, 0, 0, 0, 0, time.UTC)
	postingDate := time.Date(2026, 7, 25, 0, 0, 0, 0, time.UTC)

	orderID, orderItemID := insertStandardOrder(t, ctx, f, standardOrderSeed{
		side: SideSales, status: "audited", currencyID: f.baseCurrencyID,
		qty: decimal.NewFromInt(6), baseQty: decimal.NewFromInt(6),
		price: decimal.NewFromInt(20), amount: decimal.NewFromInt(120),
		basePrice: decimal.NewFromInt(20), baseAmount: decimal.NewFromInt(120),
		taxRate: decimal.RequireFromString("0.13"),
	})
	head := createStandardHead(t, ctx, svc, actor, f, SideSales, documentDate, f.warehouseID)
	item, err := svc.CreateItem(ctx, actor, SideSales, CreateItemInput{
		HeadID: head.ID, Idx: 1, Qty: decimal.NewFromInt(3),
		OrderItemID: orderItemID, WarehouseID: f.warehouseID,
	})
	if err != nil {
		t.Fatal(err)
	}
	seedStock(t, ctx, f, f.warehouseID, decimal.NewFromInt(10))
	// 审核后的金额必须使用履约行快照，而不是回查此处改动后的订单金额。
	if _, err := f.pool.Exec(ctx, `UPDATE sal_order_item
		SET base_amount=999,amount=999 WHERE id=$1`, orderItemID); err != nil {
		t.Fatal(err)
	}
	head, err = svc.Audit(ctx, actor, SideSales, head.ID, &postingDate)
	if err != nil {
		t.Fatal(err)
	}
	if head.Status != StatusAudited || head.PostingDate == nil ||
		!head.PostingDate.Equal(postingDate) || head.AuditedAt == nil ||
		head.AuditedByID == nil || *head.AuditedByID != f.userID {
		t.Fatalf("销售审核头 = %#v", head)
	}
	requireStockVoucher(t, ctx, f.pool, "sales.delivery", head.ID, 1, "0",
		map[uuid.UUID]string{f.warehouseID: "-3"})
	requireSalesGL(t, ctx, f, head.ID, postingDate, "60", false)
	requireDecimal(t, ctx, f.pool, "3",
		`SELECT shipped_qty FROM sal_order_item WHERE id=$1`, orderItemID)

	head, err = svc.Void(ctx, actor, SideSales, head.ID)
	if err != nil {
		t.Fatal(err)
	}
	if head.Status != StatusVoided {
		t.Fatalf("销售作废头 = %#v", head)
	}
	requireStockVoucher(t, ctx, f.pool, "sales.delivery", head.ID, 1, "1", nil)
	requireGLCounts(t, ctx, f.pool, head.ID, 2, 2)
	requireDecimal(t, ctx, f.pool, "0",
		`SELECT shipped_qty FROM sal_order_item WHERE id=$1`, orderItemID)
	if _, err := svc.UpdateItem(ctx, actor, SideSales, item.ID, UpdateItemInput{
		Qty: decimalPointer(decimal.NewFromInt(1)),
	}); standardErrorCode(err) != apierror.CodeConflict {
		t.Fatalf("作废后行编辑 error = %#v", err)
	}
	if _, err := f.pool.Exec(ctx, `UPDATE sal_delivery_item SET reconciled_qty=1 WHERE id=$1`,
		item.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Void(ctx, actor, SideSales, head.ID); standardErrorCode(err) != apierror.CodeConflict {
		t.Fatalf("重复作废 error = %#v", err)
	}

	_, zeroOrderItemID := insertStandardOrder(t, ctx, f, standardOrderSeed{
		side: SideSales, status: "audited", currencyID: f.baseCurrencyID,
		qty: decimal.NewFromInt(2), baseQty: decimal.NewFromInt(2),
		price: decimal.Zero, amount: decimal.Zero, basePrice: decimal.Zero, baseAmount: decimal.Zero,
		taxRate: decimal.RequireFromString("0.13"),
	})
	zeroHead := createStandardHead(t, ctx, svc, actor, f, SideSales, documentDate, f.warehouseID)
	if _, err := svc.CreateItem(ctx, actor, SideSales, CreateItemInput{
		HeadID: zeroHead.ID, Idx: 1, Qty: decimal.NewFromInt(2),
		OrderItemID: zeroOrderItemID, WarehouseID: f.warehouseID,
	}); err != nil {
		t.Fatal(err)
	}
	zeroHead, err = svc.Audit(ctx, actor, SideSales, zeroHead.ID, nil)
	if err != nil {
		t.Fatal(err)
	}
	if zeroHead.PostingDate == nil || !zeroHead.PostingDate.Equal(documentDate) {
		t.Fatalf("零金额审核仍补 postingDate = %#v", zeroHead.PostingDate)
	}
	requireGLCounts(t, ctx, f.pool, zeroHead.ID, 0, 0)
	requireStockVoucher(t, ctx, f.pool, "sales.delivery", zeroHead.ID, 1, "0",
		map[uuid.UUID]string{f.warehouseID: "-2"})
	requireDecimal(t, ctx, f.pool, "2",
		`SELECT shipped_qty FROM sal_order_item WHERE id=$1`, zeroOrderItemID)

	_, insufficientItemID := insertStandardOrder(t, ctx, f, standardOrderSeed{
		side: SideSales, status: "audited", currencyID: f.baseCurrencyID,
		qty: decimal.NewFromInt(2), baseQty: decimal.NewFromInt(2),
		price: decimal.NewFromInt(5), amount: decimal.NewFromInt(10),
		basePrice: decimal.NewFromInt(5), baseAmount: decimal.NewFromInt(10),
		taxRate: decimal.RequireFromString("0.13"),
	})
	insufficientHead := createStandardHead(
		t, ctx, svc, actor, f, SideSales, documentDate, f.emptyWarehouseID,
	)
	if _, err := svc.CreateItem(ctx, actor, SideSales, CreateItemInput{
		HeadID: insufficientHead.ID, Idx: 1, Qty: decimal.NewFromInt(2),
		OrderItemID: insufficientItemID, WarehouseID: f.emptyWarehouseID,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Audit(ctx, actor, SideSales, insufficientHead.ID, nil); standardErrorCode(err) != apierror.CodeConflict {
		t.Fatalf("负库存审核 error = %#v", err)
	}
	got, err := svc.GetHead(ctx, actor, SideSales, insufficientHead.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != StatusDraft || got.PostingDate != nil || got.AuditedAt != nil {
		t.Fatalf("负库存失败后头未回滚 = %#v", got)
	}
	requireDecimal(t, ctx, f.pool, "0",
		`SELECT shipped_qty FROM sal_order_item WHERE id=$1`, insufficientItemID)
	requireStockVoucher(t, ctx, f.pool, "sales.delivery", insufficientHead.ID, 0, "0", nil)
	requireGLCounts(t, ctx, f.pool, insufficientHead.ID, 0, 0)
	if orderID == uuid.Nil {
		t.Fatal("订单 fixture 未建立")
	}
}

func TestPostgresStandardPurchaseAuditDemandVoidGuardsAndRollback(t *testing.T) {
	f := newStandardPGFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Second)
	defer cancel()
	actor := standardActor(f)
	svc := NewService(f.pool)
	documentDate := time.Date(2026, 7, 21, 0, 0, 0, 0, time.UTC)

	_, orderItemID := insertStandardOrder(t, ctx, f, standardOrderSeed{
		side: SidePurchase, status: "audited", currencyID: f.baseCurrencyID,
		qty: decimal.NewFromInt(5), baseQty: decimal.NewFromInt(5),
		price: decimal.NewFromInt(20), amount: decimal.NewFromInt(100),
		basePrice: decimal.NewFromInt(20), baseAmount: decimal.NewFromInt(100),
		taxRate: decimal.RequireFromString("0.13"), demandLineID: &f.demandLineID,
	})
	head := createStandardHead(t, ctx, svc, actor, f, SidePurchase, documentDate, f.warehouseID)
	item, err := svc.CreateItem(ctx, actor, SidePurchase, CreateItemInput{
		HeadID: head.ID, Idx: 1, Qty: decimal.NewFromInt(5),
		OrderItemID: orderItemID, WarehouseID: f.warehouseID,
	})
	if err != nil {
		t.Fatal(err)
	}
	head, err = svc.Audit(ctx, actor, SidePurchase, head.ID, nil)
	if err != nil {
		t.Fatal(err)
	}
	if head.Status != StatusAudited || head.PostingDate == nil ||
		!head.PostingDate.Equal(documentDate) {
		t.Fatalf("采购审核头 = %#v", head)
	}
	requireStockVoucher(t, ctx, f.pool, "purchase.receipt", head.ID, 1, "0",
		map[uuid.UUID]string{f.warehouseID: "5"})
	requirePurchaseGL(t, ctx, f, head.ID, documentDate, "100", false)
	requireDecimal(t, ctx, f.pool, "5",
		`SELECT received_qty FROM pur_order_item WHERE id=$1`, orderItemID)
	requireDemand(t, ctx, f, "5", "completed")

	if _, err := f.pool.Exec(ctx, `UPDATE pur_receipt_item SET reconciled_qty=1 WHERE id=$1`,
		item.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Void(ctx, actor, SidePurchase, head.ID); standardErrorCode(err) != apierror.CodeConflict {
		t.Fatalf("已对账采购入库作废 error = %#v", err)
	}
	requirePurchaseFactsLive(t, ctx, f, head.ID, orderItemID, "5", "5", "completed")
	if _, err := f.pool.Exec(ctx, `UPDATE pur_receipt_item SET reconciled_qty=0 WHERE id=$1`,
		item.ID); err != nil {
		t.Fatal(err)
	}
	consumeStock(t, ctx, f, f.warehouseID, decimal.NewFromInt(-5))
	if _, err := svc.Void(ctx, actor, SidePurchase, head.ID); standardErrorCode(err) != apierror.CodeConflict {
		t.Fatalf("已耗用入库作废 error = %#v", err)
	}
	requirePurchaseFactsLive(t, ctx, f, head.ID, orderItemID, "5", "5", "completed")

	cancelConsumedStock(t, ctx, f)
	head, err = svc.Void(ctx, actor, SidePurchase, head.ID)
	if err != nil {
		t.Fatal(err)
	}
	if head.Status != StatusVoided {
		t.Fatalf("采购作废头 = %#v", head)
	}
	requireStockVoucher(t, ctx, f.pool, "purchase.receipt", head.ID, 1, "1", nil)
	requireGLCounts(t, ctx, f.pool, head.ID, 2, 2)
	requireDecimal(t, ctx, f.pool, "0",
		`SELECT received_qty FROM pur_order_item WHERE id=$1`, orderItemID)
	requireDemand(t, ctx, f, "0", "pending")

	_, zeroItemID := insertStandardOrder(t, ctx, f, standardOrderSeed{
		side: SidePurchase, status: "audited", currencyID: f.baseCurrencyID,
		qty: decimal.NewFromInt(1), baseQty: decimal.NewFromInt(1),
		price: decimal.Zero, amount: decimal.Zero, basePrice: decimal.Zero, baseAmount: decimal.Zero,
		taxRate: decimal.RequireFromString("0.13"),
	})
	zeroHead := createStandardHead(
		t, ctx, svc, actor, f, SidePurchase, documentDate, f.negativeWarehouseID,
	)
	if _, err := svc.CreateItem(ctx, actor, SidePurchase, CreateItemInput{
		HeadID: zeroHead.ID, Idx: 1, Qty: decimal.NewFromInt(1),
		OrderItemID: zeroItemID, WarehouseID: f.negativeWarehouseID,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Audit(ctx, actor, SidePurchase, zeroHead.ID, nil); err != nil {
		t.Fatal(err)
	}
	requireGLCounts(t, ctx, f.pool, zeroHead.ID, 0, 0)
	requireStockVoucher(t, ctx, f.pool, "purchase.receipt", zeroHead.ID, 1, "0",
		map[uuid.UUID]string{f.negativeWarehouseID: "1"})
}

func TestPostgresStandardToleranceDoubleAuditEditRaceAndCompetingDocuments(t *testing.T) {
	f := newStandardPGFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	actor := standardActor(f)
	svc := NewService(f.pool)
	documentDate := time.Date(2026, 7, 22, 0, 0, 0, 0, time.UTC)
	var oldRatio decimal.Decimal
	if err := f.pool.QueryRow(ctx, `SELECT delivery_overship_ratio FROM sal_setting LIMIT 1`).
		Scan(&oldRatio); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(ctx, `UPDATE sal_setting SET delivery_overship_ratio=0.2`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		restoreCtx, restoreCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer restoreCancel()
		_, _ = f.pool.Exec(restoreCtx, `UPDATE sal_setting SET delivery_overship_ratio=$1`, oldRatio)
	})

	_, boundaryItemID := insertStandardOrder(t, ctx, f, standardOrderSeed{
		side: SideSales, status: "audited", currencyID: f.baseCurrencyID,
		qty: decimal.NewFromInt(5), baseQty: decimal.NewFromInt(5),
		price: decimal.NewFromInt(10), amount: decimal.NewFromInt(50),
		basePrice: decimal.NewFromInt(10), baseAmount: decimal.NewFromInt(50),
		taxRate: decimal.RequireFromString("0.13"),
	})
	boundaryHead := createStandardHead(
		t, ctx, svc, actor, f, SideSales, documentDate, f.negativeWarehouseID,
	)
	if _, err := svc.CreateItem(ctx, actor, SideSales, CreateItemInput{
		HeadID: boundaryHead.ID, Idx: 1, Qty: decimal.NewFromInt(6),
		OrderItemID: boundaryItemID, WarehouseID: f.negativeWarehouseID,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Audit(ctx, actor, SideSales, boundaryHead.ID, nil); err != nil {
		t.Fatalf("20%% 容差边界应成功: %v", err)
	}
	requireDecimal(t, ctx, f.pool, "6",
		`SELECT shipped_qty FROM sal_order_item WHERE id=$1`, boundaryItemID)

	_, doubleItemID := insertStandardOrder(t, ctx, f, standardOrderSeed{
		side: SideSales, status: "audited", currencyID: f.baseCurrencyID,
		qty: decimal.NewFromInt(5), baseQty: decimal.NewFromInt(5),
		price: decimal.NewFromInt(10), amount: decimal.NewFromInt(50),
		basePrice: decimal.NewFromInt(10), baseAmount: decimal.NewFromInt(50),
		taxRate: decimal.RequireFromString("0.13"),
	})
	doubleHead := createStandardHead(
		t, ctx, svc, actor, f, SideSales, documentDate, f.negativeWarehouseID,
	)
	if _, err := svc.CreateItem(ctx, actor, SideSales, CreateItemInput{
		HeadID: doubleHead.ID, Idx: 1, Qty: decimal.NewFromInt(2),
		OrderItemID: doubleItemID, WarehouseID: f.negativeWarehouseID,
	}); err != nil {
		t.Fatal(err)
	}
	type auditResult struct {
		head Head
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
			got, auditErr := svc.Audit(ctx, actor, SideSales, doubleHead.ID, nil)
			results <- auditResult{head: got, err: auditErr}
		}()
	}
	close(start)
	wg.Wait()
	close(results)
	successes, conflicts := 0, 0
	for result := range results {
		switch standardErrorCode(result.err) {
		case "":
			successes++
			doubleHead = result.head
		case apierror.CodeConflict:
			conflicts++
		default:
			t.Fatalf("双审核异常结果: %v", result.err)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("双审核 successes=%d conflicts=%d", successes, conflicts)
	}
	requireStockVoucher(t, ctx, f.pool, "sales.delivery", doubleHead.ID, 1, "0",
		map[uuid.UUID]string{f.negativeWarehouseID: "-2"})
	requireGLCounts(t, ctx, f.pool, doubleHead.ID, 2, 0)
	requireDecimal(t, ctx, f.pool, "2",
		`SELECT shipped_qty FROM sal_order_item WHERE id=$1`, doubleItemID)

	_, editOrderItemID := insertStandardOrder(t, ctx, f, standardOrderSeed{
		side: SideSales, status: "audited", currencyID: f.baseCurrencyID,
		qty: decimal.NewFromInt(5), baseQty: decimal.NewFromInt(5),
		price: decimal.NewFromInt(10), amount: decimal.NewFromInt(50),
		basePrice: decimal.NewFromInt(10), baseAmount: decimal.NewFromInt(50),
		taxRate: decimal.RequireFromString("0.13"),
	})
	editHead := createStandardHead(
		t, ctx, svc, actor, f, SideSales, documentDate, f.negativeWarehouseID,
	)
	editItem, err := svc.CreateItem(ctx, actor, SideSales, CreateItemInput{
		HeadID: editHead.ID, Idx: 1, Qty: decimal.NewFromInt(1),
		OrderItemID: editOrderItemID, WarehouseID: f.negativeWarehouseID,
	})
	if err != nil {
		t.Fatal(err)
	}
	raceStart := make(chan struct{})
	auditDone := make(chan error, 1)
	editDone := make(chan error, 1)
	go func() {
		<-raceStart
		_, auditErr := svc.Audit(ctx, actor, SideSales, editHead.ID, nil)
		auditDone <- auditErr
	}()
	go func() {
		<-raceStart
		two := decimal.NewFromInt(2)
		_, editErr := svc.UpdateItem(ctx, actor, SideSales, editItem.ID, UpdateItemInput{Qty: &two})
		editDone <- editErr
	}()
	close(raceStart)
	auditErr, editErr := <-auditDone, <-editDone
	if auditErr != nil {
		t.Fatalf("审核与行编辑竞争中审核失败: %v", auditErr)
	}
	if editErr != nil && standardErrorCode(editErr) != apierror.CodeConflict {
		t.Fatalf("审核与行编辑竞争中编辑异常: %v", editErr)
	}
	liveItem, err := svc.GetItem(ctx, actor, SideSales, editItem.ID)
	if err != nil {
		t.Fatal(err)
	}
	wantProjection := liveItem.BaseQty.String()
	requireDecimal(t, ctx, f.pool, wantProjection,
		`SELECT shipped_qty FROM sal_order_item WHERE id=$1`, editOrderItemID)
	requireStockVoucher(t, ctx, f.pool, "sales.delivery", editHead.ID, 1, "0",
		map[uuid.UUID]string{f.negativeWarehouseID: liveItem.BaseQty.Neg().String()})
	if editErr == nil && !liveItem.BaseQty.Equal(decimal.NewFromInt(2)) {
		t.Fatalf("编辑先线性化但审核事实不含编辑结果: item=%#v", liveItem)
	}
	if standardErrorCode(editErr) == apierror.CodeConflict &&
		!liveItem.BaseQty.Equal(decimal.NewFromInt(1)) {
		t.Fatalf("审核先线性化但条目意外改变: item=%#v", liveItem)
	}

	_, contestedItemID := insertStandardOrder(t, ctx, f, standardOrderSeed{
		side: SideSales, status: "audited", currencyID: f.baseCurrencyID,
		qty: decimal.NewFromInt(5), baseQty: decimal.NewFromInt(5),
		price: decimal.NewFromInt(10), amount: decimal.NewFromInt(50),
		basePrice: decimal.NewFromInt(10), baseAmount: decimal.NewFromInt(50),
		taxRate: decimal.RequireFromString("0.13"),
	})
	contestedHeads := []Head{
		createStandardHead(t, ctx, svc, actor, f, SideSales, documentDate, f.negativeWarehouseID),
		createStandardHead(t, ctx, svc, actor, f, SideSales, documentDate, f.negativeWarehouseID),
	}
	for i := range contestedHeads {
		if _, err := svc.CreateItem(ctx, actor, SideSales, CreateItemInput{
			HeadID: contestedHeads[i].ID, Idx: 1, Qty: decimal.NewFromInt(4),
			OrderItemID: contestedItemID, WarehouseID: f.negativeWarehouseID,
		}); err != nil {
			t.Fatal(err)
		}
	}
	contestedStart := make(chan struct{})
	contestedResults := make(chan auditResult, 2)
	for _, candidate := range contestedHeads {
		wg.Add(1)
		go func(id uuid.UUID) {
			defer wg.Done()
			<-contestedStart
			got, auditErr := svc.Audit(ctx, actor, SideSales, id, nil)
			contestedResults <- auditResult{head: got, err: auditErr}
		}(candidate.ID)
	}
	close(contestedStart)
	wg.Wait()
	close(contestedResults)
	successes, conflicts = 0, 0
	var winner uuid.UUID
	for result := range contestedResults {
		switch standardErrorCode(result.err) {
		case "":
			successes++
			winner = result.head.ID
		case apierror.CodeConflict:
			conflicts++
		default:
			t.Fatalf("两单争余量异常结果: %v", result.err)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("两单争余量 successes=%d conflicts=%d", successes, conflicts)
	}
	requireDecimal(t, ctx, f.pool, "4",
		`SELECT shipped_qty FROM sal_order_item WHERE id=$1`, contestedItemID)
	for _, candidate := range contestedHeads {
		var status string
		if err := f.pool.QueryRow(ctx, `SELECT status FROM sal_delivery WHERE id=$1`,
			candidate.ID).Scan(&status); err != nil {
			t.Fatal(err)
		}
		if candidate.ID == winner && status != "audited" {
			t.Fatalf("赢家状态 = %s", status)
		}
		if candidate.ID != winner && status != "draft" {
			t.Fatalf("输家状态 = %s", status)
		}
	}
	var contestedStock, contestedGL int
	if err := f.pool.QueryRow(ctx, `SELECT count(*) FROM inv_stock_entry
		WHERE voucher_type='sales.delivery' AND voucher_id=ANY($1::uuid[])`,
		[]uuid.UUID{contestedHeads[0].ID, contestedHeads[1].ID}).Scan(&contestedStock); err != nil {
		t.Fatal(err)
	}
	if err := f.pool.QueryRow(ctx, `SELECT count(*) FROM acc_gl_entry
		WHERE voucher_type='sales.delivery' AND voucher_id=ANY($1::uuid[])`,
		[]uuid.UUID{contestedHeads[0].ID, contestedHeads[1].ID}).Scan(&contestedGL); err != nil {
		t.Fatal(err)
	}
	if contestedStock != 1 || contestedGL != 2 {
		t.Fatalf("两单争余量 facts stock=%d gl=%d", contestedStock, contestedGL)
	}
}

func newStandardPGFixture(t *testing.T) standardPGFixture {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	pool := testutil.NewPool(t, ctx)
	suffix := strings.ReplaceAll(uuid.NewString(), "-", "")[:12]
	f := standardPGFixture{
		pool: pool, suffix: suffix,
		companyID: uuid.New(), otherCompanyID: uuid.New(), userID: uuid.New(),
		baseCurrencyID: uuid.New(), foreignCurrencyID: uuid.New(),
		customerID: uuid.New(), supplierID: uuid.New(),
		unitID: uuid.New(), boxID: uuid.New(), unrelatedUnitID: uuid.New(),
		categoryID: uuid.New(), materialID: uuid.New(),
		warehouseID: uuid.New(), emptyWarehouseID: uuid.New(),
		negativeWarehouseID: uuid.New(), groupWarehouseID: uuid.New(),
		salesDebitID: uuid.New(), salesCreditID: uuid.New(),
		purchaseDebitID: uuid.New(), purchaseCreditID: uuid.New(),
		wrongRoleID: uuid.New(), disabledAccountID: uuid.New(),
		fileOneID: uuid.New(), fileTwoID: uuid.New(),
		demandID: uuid.New(), demandLineID: uuid.New(),
	}
	batch := &pgx.Batch{}
	batch.Queue(`INSERT INTO bas_currency(id,name,iso_code,active) VALUES
		($1,$2,$3,true),($4,$5,$6,true)`,
		f.baseCurrencyID, "履约本币-"+suffix, "CNY"+suffix,
		f.foreignCurrencyID, "履约外币-"+suffix, "USD"+suffix)
	batch.Queue(`INSERT INTO bas_company(id,code,name,short_name,base_currency_id) VALUES
		($1,$2,$3,$3,$4),($5,$6,$7,$7,$4)`,
		f.companyID, "F"+suffix, "履约公司-"+suffix, f.baseCurrencyID,
		f.otherCompanyID, "X"+suffix, "履约内部公司-"+suffix)
	batch.Queue(`INSERT INTO sys_user(
		id,username,name,hashed_password,super_admin,all_companies)
		VALUES($1,$2,$3,'test',false,false)`,
		f.userID, "fulfillment-"+suffix, "履约用户-"+suffix)
	batch.Queue(`INSERT INTO sal_customers(id,code,name) VALUES($1,$2,$3)`,
		f.customerID, "C"+suffix, "履约客户-"+suffix)
	batch.Queue(`INSERT INTO pur_supplier(id,code,name) VALUES($1,$2,$3)`,
		f.supplierID, "S"+suffix, "履约供应商-"+suffix)
	batch.Queue(`INSERT INTO bas_unit(id,unit_type,is_base,name,symbol,ratio) VALUES
		($1,$7,true,$2,$3,1),($4,$7,false,$5,$6,10),
		($8,$9,true,$10,$11,1)`,
		f.unitID, "履约个-"+suffix, "EA"+suffix,
		f.boxID, "履约箱-"+suffix, "BOX"+suffix, "fulfillment-"+suffix,
		f.unrelatedUnitID, "unrelated-"+suffix, "无关单位-"+suffix, "BAD"+suffix)
	batch.Queue(`INSERT INTO inv_material_category(id,code,name,is_leaf,active)
		VALUES($1,$2,$3,true,true)`,
		f.categoryID, "MC"+suffix, "履约分类-"+suffix)
	batch.Queue(`INSERT INTO inv_material(
		id,code,name,spec,customer_part_no,category_id,default_unit_id)
		VALUES($1,$2,$3,$4,$5,$6,$7)`,
		f.materialID, "M"+suffix, "履约物料-"+suffix, "SPEC-"+suffix, "PART-"+suffix,
		f.categoryID, f.unitID)
	batch.Queue(`INSERT INTO inv_material_unit(material_id,unit_id,factor)
		VALUES($1,$2,10)`, f.materialID, f.boxID)
	batch.Queue(`INSERT INTO inv_warehouse(
		id,name,is_leaf,active,allow_negative,company_id) VALUES
		($1,$2,true,true,false,$3),
		($4,$5,true,true,false,$3),
		($6,$7,true,true,true,$3),
		($8,$9,false,true,false,$3)`,
		f.warehouseID, "履约主仓-"+suffix, f.companyID,
		f.emptyWarehouseID, "履约空仓-"+suffix,
		f.negativeWarehouseID, "履约负库存仓-"+suffix,
		f.groupWarehouseID, "履约汇总仓-"+suffix)
	batch.Queue(`INSERT INTO bas_account(
		id,code,name,direction,is_group,active,role,company_id,currency_id) VALUES
		($1,$2,$3,'debit',false,true,'unbilled_receivable',$4,$5),
		($6,$7,$8,'credit',false,true,NULL,$4,$9),
		($10,$11,$12,'debit',false,true,NULL,$4,$5),
		($13,$14,$15,'credit',false,true,'unbilled_payable',$4,$9),
		($16,$17,$18,'debit',false,true,'receivable',$4,$5),
		($19,$20,$21,'credit',false,false,'unbilled_payable',$4,$5)`,
		f.salesDebitID, "SD"+suffix, "未开票应收-"+suffix, f.companyID, f.baseCurrencyID,
		f.salesCreditID, "SC"+suffix, "销售贷方-"+suffix, f.foreignCurrencyID,
		f.purchaseDebitID, "PD"+suffix, "采购借方-"+suffix,
		f.purchaseCreditID, "PC"+suffix, "未开票应付-"+suffix,
		f.wrongRoleID, "WR"+suffix, "错误角色-"+suffix,
		f.disabledAccountID, "DA"+suffix, "停用科目-"+suffix)
	batch.Queue(`INSERT INTO sys_file(id,storage,key,filename,content_type,size) VALUES
		($1,'local',$2,$3,'application/pdf',10),
		($4,'local',$5,$6,'application/pdf',20)`,
		f.fileOneID, "drawing-one-"+suffix, "图纸一-"+suffix+".pdf",
		f.fileTwoID, "drawing-two-"+suffix, "图纸二-"+suffix+".pdf")
	batch.Queue(`INSERT INTO sys_attachment(
		owner_type,owner_id,category,file_id,company_id) VALUES
		('inv_material',$1,'drawing',$2,$3),
		('inv_material',$1,'manual',$4,$3)`,
		f.materialID, f.fileOneID, f.companyID, f.fileTwoID)
	batch.Queue(`INSERT INTO mfg_demand(
		id,demand_no,demand_date,status,company_id,created_by_id)
		VALUES($1,$2,CURRENT_DATE,'confirmed',$3,$4)`,
		f.demandID, "D-"+suffix, f.companyID, f.userID)
	batch.Queue(`INSERT INTO mfg_demand_item(
		id,idx,qty,base_qty,need_date,fulfillment_method,status,
		material_code,material_name,unit_name,demand_id,company_id,material_id,unit_id,
		ordered_qty,received_qty)
		VALUES($1,1,5,5,CURRENT_DATE,'purchase','pending',$2,$3,$4,$5,$6,$7,$8,5,0)`,
		f.demandLineID, "M"+suffix, "履约物料-"+suffix, "履约个-"+suffix,
		f.demandID, f.companyID, f.materialID, f.unitID)
	results := pool.SendBatch(ctx, batch)
	if err := results.Close(); err != nil {
		pool.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupStandardPGFixture(f)
	})
	return f
}

func cleanupStandardPGFixture(f standardPGFixture) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	queries := []struct {
		sql  string
		args []any
	}{
		{`DELETE FROM sys_attachment WHERE company_id=$1`, []any{f.companyID}},
		{`DELETE FROM sys_audit_log WHERE company_id=$1`, []any{f.companyID}},
		{`DELETE FROM acc_gl_entry WHERE company_id=$1`, []any{f.companyID}},
		{`DELETE FROM inv_stock_entry WHERE company_id=$1`, []any{f.companyID}},
		{`DELETE FROM sal_delivery WHERE company_id=$1`, []any{f.companyID}},
		{`DELETE FROM pur_receipt WHERE company_id=$1`, []any{f.companyID}},
		{`DELETE FROM sal_order WHERE company_id=$1`, []any{f.companyID}},
		{`DELETE FROM pur_order WHERE company_id=$1`, []any{f.companyID}},
		{`DELETE FROM mfg_demand WHERE id=$1`, []any{f.demandID}},
		{`DELETE FROM inv_material_unit WHERE material_id=$1`, []any{f.materialID}},
		{`DELETE FROM inv_warehouse WHERE company_id=$1`, []any{f.companyID}},
		{`DELETE FROM bas_account WHERE company_id=$1`, []any{f.companyID}},
		{`DELETE FROM inv_material WHERE id=$1`, []any{f.materialID}},
		{`DELETE FROM inv_material_category WHERE id=$1`, []any{f.categoryID}},
		{`DELETE FROM bas_unit WHERE id=ANY($1::uuid[])`,
			[]any{[]uuid.UUID{f.unitID, f.boxID, f.unrelatedUnitID}}},
		{`DELETE FROM pur_supplier WHERE id=$1`, []any{f.supplierID}},
		{`DELETE FROM sal_customers WHERE id=$1`, []any{f.customerID}},
		{`DELETE FROM sys_file WHERE id=ANY($1::uuid[])`,
			[]any{[]uuid.UUID{f.fileOneID, f.fileTwoID}}},
		{`DELETE FROM sys_user WHERE id=$1`, []any{f.userID}},
		{`DELETE FROM bas_company WHERE id=ANY($1::uuid[])`,
			[]any{[]uuid.UUID{f.companyID, f.otherCompanyID}}},
		{`DELETE FROM bas_currency WHERE id=ANY($1::uuid[])`,
			[]any{[]uuid.UUID{f.baseCurrencyID, f.foreignCurrencyID}}},
	}
	for _, query := range queries {
		_, _ = f.pool.Exec(ctx, query.sql, query.args...)
	}
	f.pool.Close()
}

func standardActor(f standardPGFixture) *authz.Actor {
	return &authz.Actor{
		UserID: f.userID, Username: "fulfillment-test",
		CompanyIDs: []uuid.UUID{f.companyID},
		Permissions: map[string]struct{}{
			"sales.delivery:*": {}, "purchase.receipt:*": {},
		},
	}
}

func insertStandardOrder(
	t *testing.T,
	ctx context.Context,
	f standardPGFixture,
	seed standardOrderSeed,
) (uuid.UUID, uuid.UUID) {
	t.Helper()
	orderID, itemID := uuid.New(), uuid.New()
	orderNo := "SO-" + orderID.String()
	partyType, partyID := "customer", f.customerID
	orderTable, itemTable := "sal_order", "sal_order_item"
	if seed.side == SidePurchase {
		orderNo = "PO-" + orderID.String()
		partyType, partyID = "supplier", f.supplierID
		orderTable, itemTable = "pur_order", "pur_order_item"
	}
	tx, err := f.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	materialID := seed.materialID
	if materialID == uuid.Nil {
		materialID = f.materialID
	}
	if seed.side == SideSales {
		_, err = tx.Exec(ctx, `INSERT INTO `+orderTable+`(
			id,order_no,party_type,party_id,status,company_id,currency_id)
			VALUES($1,$2,$3,$4,$5,$6,$7)`,
			orderID, orderNo, partyType, partyID, seed.status, f.companyID, seed.currencyID)
	} else {
		_, err = tx.Exec(ctx, `INSERT INTO `+orderTable+`(
			id,order_no,party_type,party_id,status,company_id,currency_id,is_outsourced)
			VALUES($1,$2,$3,$4,$5,$6,$7,false)`,
			orderID, orderNo, partyType, partyID, seed.status, f.companyID, seed.currencyID)
	}
	if err != nil {
		t.Fatal(err)
	}
	if seed.side == SideSales {
		_, err = tx.Exec(ctx, `INSERT INTO `+itemTable+`(
			id,idx,qty,base_qty,shipped_qty,price,amount,base_price,base_amount,tax_rate,
			material_code,material_name,material_spec,customer_part_no,unit_name,
			order_id,company_id,material_id,unit_id)
			VALUES($1,1,$2,$3,0,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
			itemID, seed.qty, seed.baseQty, seed.price, seed.amount, seed.basePrice,
			seed.baseAmount, seed.taxRate, "ORDER-M"+f.suffix, "订单物料-"+f.suffix,
			"ORDER-SPEC-"+f.suffix, "ORDER-PART-"+f.suffix, "履约个-"+f.suffix,
			orderID, f.companyID, materialID, f.unitID)
	} else {
		_, err = tx.Exec(ctx, `INSERT INTO `+itemTable+`(
			id,idx,qty,base_qty,received_qty,price,amount,base_price,base_amount,tax_rate,
			material_code,material_name,material_spec,customer_part_no,unit_name,
			order_id,company_id,material_id,unit_id,demand_line_id)
			VALUES($1,1,$2,$3,0,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
			itemID, seed.qty, seed.baseQty, seed.price, seed.amount, seed.basePrice,
			seed.baseAmount, seed.taxRate, "ORDER-M"+f.suffix, "订单物料-"+f.suffix,
			"ORDER-SPEC-"+f.suffix, "ORDER-PART-"+f.suffix, "履约个-"+f.suffix,
			orderID, f.companyID, materialID, f.unitID, seed.demandLineID)
	}
	if err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	return orderID, itemID
}

func createStandardHead(
	t *testing.T,
	ctx context.Context,
	svc *Service,
	actor *authz.Actor,
	f standardPGFixture,
	side Side,
	documentDate time.Time,
	warehouseID uuid.UUID,
) Head {
	t.Helper()
	number := fmt.Sprintf("%s-%s", side, strings.ReplaceAll(uuid.NewString(), "-", "")[:20])
	input := CreateHeadInput{
		CompanyID: f.companyID, No: &number, DocumentDate: &documentDate,
		WarehouseID: &warehouseID,
	}
	if side == SideSales {
		input.PartyType, input.PartyID = "CUSTOMER", f.customerID
		input.DebitAccountID, input.CreditAccountID = f.salesDebitID, f.salesCreditID
	} else {
		input.PartyType, input.PartyID = "SUPPLIER", f.supplierID
		input.DebitAccountID, input.CreditAccountID = f.purchaseDebitID, f.purchaseCreditID
	}
	result, err := svc.CreateHead(ctx, actor, side, input)
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func assertCreateHeadCode(
	t *testing.T,
	svc *Service,
	ctx context.Context,
	actor *authz.Actor,
	side Side,
	f standardPGFixture,
	partyType string,
	partyID uuid.UUID,
	warehouseID *uuid.UUID,
	debitID, creditID uuid.UUID,
	want apierror.Code,
) {
	t.Helper()
	number := "INVALID-" + uuid.NewString()
	_, err := svc.CreateHead(ctx, actor, side, CreateHeadInput{
		CompanyID: f.companyID, No: &number, PartyType: partyType, PartyID: partyID,
		WarehouseID: warehouseID, DebitAccountID: debitID, CreditAccountID: creditID,
	})
	if standardErrorCode(err) != want {
		t.Fatalf("CreateHead(%s,%s) error = %#v, want %s", side, partyType, err, want)
	}
}

func standardErrorCode(err error) apierror.Code {
	if err == nil {
		return ""
	}
	var target *apierror.Error
	if errors.As(err, &target) {
		return target.Code
	}
	return apierror.CodeInternal
}

func decimalPointer(value decimal.Decimal) *decimal.Decimal {
	return &value
}

func requireDrawingFiles(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	ownerType string,
	ownerID uuid.UUID,
	want []uuid.UUID,
) {
	t.Helper()
	rows, err := pool.Query(ctx, `SELECT file_id FROM sys_attachment
		WHERE owner_type=$1 AND owner_id=$2 AND category='drawing' ORDER BY file_id`,
		ownerType, ownerID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	got := make([]uuid.UUID, 0)
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			t.Fatal(err)
		}
		got = append(got, id)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("图纸 file IDs = %v, want %v", got, want)
	}
}

func seedStock(
	t *testing.T,
	ctx context.Context,
	f standardPGFixture,
	warehouseID uuid.UUID,
	quantity decimal.Decimal,
) {
	t.Helper()
	tx, err := f.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if err := stock.Post(ctx, tx, stock.Voucher{
		Type: "test.standard.seed", ID: uuid.New(), No: "SEED-" + uuid.NewString(),
		CompanyID: f.companyID, PostingDate: time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC),
	}, []stock.Line{{
		WarehouseID: warehouseID, MaterialID: f.materialID, Quantity: quantity,
	}}); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
}

const consumedStockVoucherType = "test.standard.consume"

func consumeStock(
	t *testing.T,
	ctx context.Context,
	f standardPGFixture,
	warehouseID uuid.UUID,
	quantity decimal.Decimal,
) {
	t.Helper()
	tx, err := f.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if err := stock.Post(ctx, tx, stock.Voucher{
		Type: consumedStockVoucherType, ID: f.companyID, No: "CONSUME-" + f.suffix,
		CompanyID: f.companyID, PostingDate: time.Date(2026, 7, 23, 0, 0, 0, 0, time.UTC),
	}, []stock.Line{{
		WarehouseID: warehouseID, MaterialID: f.materialID, Quantity: quantity,
	}}); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
}

func cancelConsumedStock(t *testing.T, ctx context.Context, f standardPGFixture) {
	t.Helper()
	tx, err := f.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if err := stock.Cancel(ctx, tx, stock.VoucherRef{
		Type: consumedStockVoucherType, ID: f.companyID,
	}, time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
}

func requireDecimal(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	want string,
	query string,
	args ...any,
) {
	t.Helper()
	var got decimal.Decimal
	if err := pool.QueryRow(ctx, query, args...).Scan(&got); err != nil {
		t.Fatal(err)
	}
	expected := decimal.RequireFromString(want)
	if !got.Equal(expected) {
		t.Fatalf("%s: got %s, want %s", query, got, expected)
	}
}

func requireStockVoucher(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	voucherType string,
	voucherID uuid.UUID,
	wantCount int,
	wantCancelled string,
	wantByWarehouse map[uuid.UUID]string,
) {
	t.Helper()
	var count, cancelled int
	if err := pool.QueryRow(ctx, `SELECT count(*),
		count(*) FILTER (WHERE is_cancelled)
		FROM inv_stock_entry WHERE voucher_type=$1 AND voucher_id=$2`,
		voucherType, voucherID).Scan(&count, &cancelled); err != nil {
		t.Fatal(err)
	}
	wantCancelledCount, err := decimal.NewFromString(wantCancelled)
	if err != nil {
		t.Fatal(err)
	}
	if count != wantCount || int64(cancelled) != wantCancelledCount.IntPart() {
		t.Fatalf("库存 facts count=%d cancelled=%d, want=%d/%s",
			count, cancelled, wantCount, wantCancelled)
	}
	for warehouseID, want := range wantByWarehouse {
		requireDecimal(t, ctx, pool, want, `SELECT COALESCE(sum(quantity),0)
			FROM inv_stock_entry WHERE voucher_type=$1 AND voucher_id=$2
			AND warehouse_id=$3 AND is_cancelled=false`,
			voucherType, voucherID, warehouseID)
	}
}

func requireGLCounts(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	voucherID uuid.UUID,
	wantCount, wantCancelled int,
) {
	t.Helper()
	var count, cancelled int
	if err := pool.QueryRow(ctx, `SELECT count(*),
		count(*) FILTER (WHERE is_cancelled)
		FROM acc_gl_entry WHERE voucher_id=$1`, voucherID).Scan(&count, &cancelled); err != nil {
		t.Fatal(err)
	}
	if count != wantCount || cancelled != wantCancelled {
		t.Fatalf("GL facts count=%d cancelled=%d, want=%d/%d",
			count, cancelled, wantCount, wantCancelled)
	}
}

func requireSalesGL(
	t *testing.T,
	ctx context.Context,
	f standardPGFixture,
	voucherID uuid.UUID,
	postingDate time.Time,
	amount string,
	cancelled bool,
) {
	t.Helper()
	requireStandardGL(t, ctx, f, voucherID, postingDate, amount, cancelled, SideSales)
}

func requirePurchaseGL(
	t *testing.T,
	ctx context.Context,
	f standardPGFixture,
	voucherID uuid.UUID,
	postingDate time.Time,
	amount string,
	cancelled bool,
) {
	t.Helper()
	requireStandardGL(t, ctx, f, voucherID, postingDate, amount, cancelled, SidePurchase)
}

func requireStandardGL(
	t *testing.T,
	ctx context.Context,
	f standardPGFixture,
	voucherID uuid.UUID,
	postingDate time.Time,
	amount string,
	cancelled bool,
	side Side,
) {
	t.Helper()
	rows, err := f.pool.Query(ctx, `SELECT account_id,currency_id,debit,credit,
		party_type,party_id,posting_date,is_cancelled
		FROM acc_gl_entry WHERE voucher_id=$1 ORDER BY seq`, voucherID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	type row struct {
		accountID  uuid.UUID
		currencyID *uuid.UUID
		debit      decimal.Decimal
		credit     decimal.Decimal
		partyType  *string
		partyID    *uuid.UUID
		date       time.Time
		cancelled  bool
	}
	got := make([]row, 0, 2)
	for rows.Next() {
		var item row
		if err := rows.Scan(
			&item.accountID, &item.currencyID, &item.debit, &item.credit,
			&item.partyType, &item.partyID, &item.date, &item.cancelled,
		); err != nil {
			t.Fatal(err)
		}
		got = append(got, item)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("GL rows = %#v", got)
	}
	wantAmount := decimal.RequireFromString(amount)
	debit, credit := got[0], got[1]
	if debit.accountID != f.salesDebitID && debit.accountID != f.purchaseDebitID {
		debit, credit = credit, debit
	}
	wantDebitID, wantCreditID := f.salesDebitID, f.salesCreditID
	partyRow := debit
	if side == SidePurchase {
		wantDebitID, wantCreditID = f.purchaseDebitID, f.purchaseCreditID
		partyRow = credit
	}
	if debit.accountID != wantDebitID || credit.accountID != wantCreditID ||
		!debit.debit.Equal(wantAmount) || !debit.credit.IsZero() ||
		!credit.credit.Equal(wantAmount) || !credit.debit.IsZero() ||
		debit.currencyID == nil || *debit.currencyID != f.baseCurrencyID ||
		credit.currencyID == nil || *credit.currencyID != f.foreignCurrencyID ||
		!debit.date.Equal(postingDate) || !credit.date.Equal(postingDate) ||
		debit.cancelled != cancelled || credit.cancelled != cancelled {
		t.Fatalf("GL rows = %#v", got)
	}
	if partyRow.partyType == nil || partyRow.partyID == nil ||
		*partyRow.partyID != map[Side]uuid.UUID{
			SideSales: f.customerID, SidePurchase: f.supplierID,
		}[side] {
		t.Fatalf("往来 GL row = %#v", partyRow)
	}
	plainRow := credit
	if side == SidePurchase {
		plainRow = debit
	}
	if plainRow.partyType != nil || plainRow.partyID != nil {
		t.Fatalf("非往来 GL row = %#v", plainRow)
	}
}

func requireDemand(
	t *testing.T,
	ctx context.Context,
	f standardPGFixture,
	wantReceived, wantStatus string,
) {
	t.Helper()
	var received decimal.Decimal
	var status string
	if err := f.pool.QueryRow(ctx, `SELECT received_qty,status
		FROM mfg_demand_item WHERE id=$1`, f.demandLineID).Scan(&received, &status); err != nil {
		t.Fatal(err)
	}
	if !received.Equal(decimal.RequireFromString(wantReceived)) || status != wantStatus {
		t.Fatalf("需求投影 received=%s status=%s, want=%s/%s",
			received, status, wantReceived, wantStatus)
	}
}

func requirePurchaseFactsLive(
	t *testing.T,
	ctx context.Context,
	f standardPGFixture,
	headID, orderItemID uuid.UUID,
	wantStock, wantOrder, wantDemandStatus string,
) {
	t.Helper()
	var status string
	if err := f.pool.QueryRow(ctx, `SELECT status FROM pur_receipt WHERE id=$1`,
		headID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "audited" {
		t.Fatalf("失败作废后采购头状态 = %s", status)
	}
	requireStockVoucher(t, ctx, f.pool, "purchase.receipt", headID, 1, "0",
		map[uuid.UUID]string{f.warehouseID: wantStock})
	requireGLCounts(t, ctx, f.pool, headID, 2, 0)
	requireDecimal(t, ctx, f.pool, wantOrder,
		`SELECT received_qty FROM pur_order_item WHERE id=$1`, orderItemID)
	requireDemand(t, ctx, f, wantOrder, wantDemandStatus)
}
