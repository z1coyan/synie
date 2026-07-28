package order

import (
	"context"
	"fmt"
	"sort"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
)

func TestPostgresOrderProjectionSalesToleranceAndAggregation(t *testing.T) {
	f := newOrderFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	tx, err := f.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `UPDATE sal_setting SET delivery_overship_ratio=0.1`); err != nil {
		t.Fatal(err)
	}

	orderID, itemID := uuid.New(), uuid.New()
	insertProjectionOrder(t, ctx, tx, f, SideSales, orderID, false, "audited")
	insertProjectionItem(t, ctx, tx, f, SideSales, orderID, itemID, 1,
		decimal.NewFromInt(10), nil)

	svc := NewService(f.pool)
	input := FulfillmentInput{
		CompanyID: f.companyID, PartyType: "customer", PartyID: f.customerID,
		Lines: []FulfillmentLine{
			{OrderItemID: itemID, BaseQty: decimal.NewFromInt(6)},
			{OrderItemID: itemID, BaseQty: decimal.NewFromInt(5)},
		},
	}
	if err := svc.PostFulfillment(ctx, tx, SideSales, input); err != nil {
		t.Fatalf("post aggregated sales fulfillment: %v", err)
	}
	requireProjectionQuantity(t, ctx, tx, "sal_order_item", "shipped_qty", itemID, "11")

	input.Lines = []FulfillmentLine{{
		OrderItemID: itemID, BaseQty: decimal.RequireFromString("0.01"),
	}}
	if err := svc.PostFulfillment(ctx, tx, SideSales, input); orderErrorCode(err) != apierror.CodeConflict {
		t.Fatalf("post beyond sales tolerance error = %#v", err)
	}
	requireProjectionQuantity(t, ctx, tx, "sal_order_item", "shipped_qty", itemID, "11")
}

func TestPostgresOrderProjectionPurchaseReceivedCompletesAndFallsBackDemand(t *testing.T) {
	f := newOrderFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	tx, err := f.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)

	orderID, itemID := uuid.New(), uuid.New()
	insertProjectionOrder(t, ctx, tx, f, SidePurchase, orderID, false, "audited")
	insertProjectionItem(t, ctx, tx, f, SidePurchase, orderID, itemID, 1,
		decimal.NewFromInt(5), &f.demandLineID)

	svc := NewService(f.pool)
	input := FulfillmentInput{
		CompanyID: f.companyID, PartyType: "supplier", PartyID: f.supplierID,
		Lines: []FulfillmentLine{{
			OrderItemID: itemID, BaseQty: decimal.NewFromInt(5),
		}},
	}
	if err := svc.PostFulfillment(ctx, tx, SidePurchase, input); err != nil {
		t.Fatalf("post purchase fulfillment: %v", err)
	}
	requireProjectionQuantity(t, ctx, tx, "pur_order_item", "received_qty", itemID, "5")
	requireDemandProjection(t, ctx, tx, f.demandLineID, "5", "completed")

	input.Lines[0].BaseQty = decimal.NewFromInt(2)
	if err := svc.ReverseFulfillment(ctx, tx, SidePurchase, input); err != nil {
		t.Fatalf("reverse purchase fulfillment: %v", err)
	}
	requireProjectionQuantity(t, ctx, tx, "pur_order_item", "received_qty", itemID, "3")
	requireDemandProjection(t, ctx, tx, f.demandLineID, "3", "pending")
}

func TestPostgresOrderProjectionStandardPurchaseAcceptsOutsourcedOrder(t *testing.T) {
	f := newOrderFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	tx, err := f.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)

	regularOrderID, regularItemID := uuid.New(), uuid.New()
	outsourcedOrderID, outsourcedItemID := uuid.New(), uuid.New()
	insertProjectionOrder(t, ctx, tx, f, SidePurchase, regularOrderID, false, "audited")
	insertProjectionItem(t, ctx, tx, f, SidePurchase, regularOrderID, regularItemID, 1,
		decimal.NewFromInt(10), nil)
	insertProjectionOrder(t, ctx, tx, f, SidePurchase, outsourcedOrderID, true, "audited")
	insertProjectionItem(t, ctx, tx, f, SidePurchase, outsourcedOrderID, outsourcedItemID, 1,
		decimal.NewFromInt(10), nil)

	input := FulfillmentInput{
		CompanyID: f.companyID, PartyType: "SUPPLIER", PartyID: f.supplierID,
		Lines: []FulfillmentLine{
			{OrderItemID: regularItemID, BaseQty: decimal.NewFromInt(2)},
			{OrderItemID: outsourcedItemID, BaseQty: decimal.NewFromInt(3)},
		},
	}
	if err := NewService(f.pool).PostFulfillment(ctx, tx, SidePurchase, input); err != nil {
		t.Fatalf("standard purchase receipt across regular and outsourced orders: %v", err)
	}
	requireProjectionQuantity(t, ctx, tx, "pur_order_item", "received_qty", regularItemID, "2")
	requireProjectionQuantity(t, ctx, tx, "pur_order_item", "received_qty", outsourcedItemID, "3")
}

func TestPostgresOrderProjectionOutsourcedReceiptRequiresOutsourcedOrder(t *testing.T) {
	f := newOrderFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	tx, err := f.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)

	regularOrderID, regularItemID := uuid.New(), uuid.New()
	outsourcedOrderID, outsourcedItemID := uuid.New(), uuid.New()
	insertProjectionOrder(t, ctx, tx, f, SidePurchase, regularOrderID, false, "audited")
	insertProjectionItem(t, ctx, tx, f, SidePurchase, regularOrderID, regularItemID, 1,
		decimal.NewFromInt(10), nil)
	insertProjectionOrder(t, ctx, tx, f, SidePurchase, outsourcedOrderID, true, "audited")
	insertProjectionItem(t, ctx, tx, f, SidePurchase, outsourcedOrderID, outsourcedItemID, 1,
		decimal.NewFromInt(10), nil)

	requireOutsourced := true
	input := FulfillmentInput{
		CompanyID: f.companyID, PartyType: "supplier", PartyID: f.supplierID,
		RequireOutsourced: &requireOutsourced,
		Lines: []FulfillmentLine{{
			OrderItemID: regularItemID, BaseQty: decimal.NewFromInt(1),
		}},
	}
	svc := NewService(f.pool)
	if err := svc.PostFulfillment(ctx, tx, SidePurchase, input); orderErrorCode(err) != apierror.CodeConflict {
		t.Fatalf("outsourced receipt from regular order error = %#v", err)
	}
	requireProjectionQuantity(t, ctx, tx, "pur_order_item", "received_qty", regularItemID, "0")

	input.Lines[0].OrderItemID = outsourcedItemID
	if err := svc.PostFulfillment(ctx, tx, SidePurchase, input); err != nil {
		t.Fatalf("outsourced receipt from outsourced order: %v", err)
	}
	requireProjectionQuantity(t, ctx, tx, "pur_order_item", "received_qty", outsourcedItemID, "1")
}

func TestPostgresOrderProjectionOutsourcedIssueCanOverIssueAndCannotReverseBelowZero(t *testing.T) {
	f := newOrderFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	tx, err := f.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)

	orderID, itemID, materialLineID := uuid.New(), uuid.New(), uuid.New()
	insertProjectionOrder(t, ctx, tx, f, SidePurchase, orderID, true, "audited")
	insertProjectionItem(t, ctx, tx, f, SidePurchase, orderID, itemID, 1,
		decimal.NewFromInt(10), nil)
	if _, err := tx.Exec(ctx, `INSERT INTO pur_order_item_material(
		id,quantity,order_item_id,company_id,material_id,unit_id)
		VALUES($1,1,$2,$3,$4,$5)`,
		materialLineID, itemID, f.companyID, f.materialID, f.unitID); err != nil {
		t.Fatal(err)
	}

	svc := NewService(f.pool)
	input := OutsourcedIssueInput{
		CompanyID: f.companyID, PartyType: "supplier", PartyID: f.supplierID,
		Lines: []OutsourcedIssueLine{{
			OrderItemMaterialID: materialLineID, BaseQty: decimal.NewFromInt(3),
		}},
	}
	if err := svc.PostOutsourcedIssue(ctx, tx, input); err != nil {
		t.Fatalf("post outsourced over-issue: %v", err)
	}
	requireProjectionQuantity(t, ctx, tx, "pur_order_item_material", "issued_qty", materialLineID, "3")

	if err := svc.ReverseOutsourcedIssue(ctx, tx, input); err != nil {
		t.Fatalf("reverse outsourced issue to zero: %v", err)
	}
	requireProjectionQuantity(t, ctx, tx, "pur_order_item_material", "issued_qty", materialLineID, "0")

	input.Lines[0].BaseQty = decimal.RequireFromString("0.01")
	if err := svc.ReverseOutsourcedIssue(ctx, tx, input); orderErrorCode(err) != apierror.CodeConflict {
		t.Fatalf("reverse outsourced issue below zero error = %#v", err)
	}
	requireProjectionQuantity(t, ctx, tx, "pur_order_item_material", "issued_qty", materialLineID, "0")
}

func TestPostgresOrderProjectionFailedTransactionRollsBackAndReverseInputsUseOneLockOrder(t *testing.T) {
	f := newOrderFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	svc := NewService(f.pool)

	rollbackOrderID := uuid.New()
	rollbackItemIDs := []uuid.UUID{uuid.New(), uuid.New()}
	sort.Slice(rollbackItemIDs, func(i, j int) bool {
		return rollbackItemIDs[i].String() < rollbackItemIDs[j].String()
	})
	setupTx, err := f.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	insertProjectionOrder(t, ctx, setupTx, f, SideSales, rollbackOrderID, false, "audited")
	insertProjectionItem(t, ctx, setupTx, f, SideSales, rollbackOrderID, rollbackItemIDs[0], 1,
		decimal.NewFromInt(10), nil)
	insertProjectionItem(t, ctx, setupTx, f, SideSales, rollbackOrderID, rollbackItemIDs[1], 2,
		decimal.NewFromInt(1), nil)
	if err := setupTx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	failedTx, err := f.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	failedInput := FulfillmentInput{
		CompanyID: f.companyID, PartyType: "customer", PartyID: f.customerID,
		Lines: []FulfillmentLine{
			{OrderItemID: rollbackItemIDs[0], BaseQty: decimal.NewFromInt(1)},
			{OrderItemID: rollbackItemIDs[1], BaseQty: decimal.NewFromInt(2)},
		},
	}
	if err := svc.PostFulfillment(ctx, failedTx, SideSales, failedInput); orderErrorCode(err) != apierror.CodeConflict {
		_ = failedTx.Rollback(ctx)
		t.Fatalf("partially applied fulfillment error = %#v", err)
	}
	if err := failedTx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	requireProjectionQuantity(t, ctx, f.pool, "sal_order_item", "shipped_qty", rollbackItemIDs[0], "0")
	requireProjectionQuantity(t, ctx, f.pool, "sal_order_item", "shipped_qty", rollbackItemIDs[1], "0")

	orderIDs := []uuid.UUID{uuid.New(), uuid.New()}
	itemIDs := []uuid.UUID{uuid.New(), uuid.New()}
	setupTx, err = f.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for i := range orderIDs {
		insertProjectionOrder(t, ctx, setupTx, f, SideSales, orderIDs[i], false, "audited")
		insertProjectionItem(t, ctx, setupTx, f, SideSales, orderIDs[i], itemIDs[i], 1,
			decimal.NewFromInt(10), nil)
	}
	if err := setupTx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	start := make(chan struct{})
	errs := make(chan error, 2)
	var wg sync.WaitGroup
	for worker := range 2 {
		wg.Add(1)
		go func(reverse bool) {
			defer wg.Done()
			tx, beginErr := f.pool.Begin(ctx)
			if beginErr != nil {
				errs <- beginErr
				return
			}
			defer tx.Rollback(ctx)
			lines := []FulfillmentLine{
				{OrderItemID: itemIDs[0], BaseQty: decimal.NewFromInt(1)},
				{OrderItemID: itemIDs[1], BaseQty: decimal.NewFromInt(1)},
			}
			if reverse {
				lines[0], lines[1] = lines[1], lines[0]
			}
			<-start
			err := svc.PostFulfillment(ctx, tx, SideSales, FulfillmentInput{
				CompanyID: f.companyID, PartyType: "CUSTOMER", PartyID: f.customerID,
				Lines: lines,
			})
			if err == nil {
				err = tx.Commit(ctx)
			}
			errs <- err
		}(worker == 1)
	}
	close(start)
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("opposite-order concurrent fulfillment: %v", err)
		}
	}
	for _, itemID := range itemIDs {
		requireProjectionQuantity(t, ctx, f.pool, "sal_order_item", "shipped_qty", itemID, "2")
	}
}

type projectionQueryer interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func insertProjectionOrder(
	t *testing.T,
	ctx context.Context,
	tx pgx.Tx,
	f orderFixture,
	side Side,
	orderID uuid.UUID,
	isOutsourced bool,
	status string,
) {
	t.Helper()
	orderNo := fmt.Sprintf("PROJ-%s-%s", side, orderID)
	var err error
	switch side {
	case SideSales:
		_, err = tx.Exec(ctx, `INSERT INTO sal_order(
			id,order_no,party_type,party_id,status,company_id,currency_id)
			VALUES($1,$2,'CUSTOMER',$3,$4,$5,$6)`,
			orderID, orderNo, f.customerID, status, f.companyID, f.currencyID)
	case SidePurchase:
		_, err = tx.Exec(ctx, `INSERT INTO pur_order(
			id,order_no,party_type,party_id,status,company_id,currency_id,is_outsourced)
			VALUES($1,$2,'SUPPLIER',$3,$4,$5,$6,$7)`,
			orderID, orderNo, f.supplierID, status, f.companyID, f.currencyID, isOutsourced)
	default:
		t.Fatalf("unsupported projection side %q", side)
	}
	if err != nil {
		t.Fatal(err)
	}
}

func insertProjectionItem(
	t *testing.T,
	ctx context.Context,
	tx pgx.Tx,
	f orderFixture,
	side Side,
	orderID uuid.UUID,
	itemID uuid.UUID,
	idx int64,
	baseQty decimal.Decimal,
	demandLineID *uuid.UUID,
) {
	t.Helper()
	var err error
	switch side {
	case SideSales:
		_, err = tx.Exec(ctx, `INSERT INTO sal_order_item(
			id,idx,qty,base_qty,price,material_code,material_name,unit_name,
			order_id,company_id,material_id,unit_id)
			VALUES($1,$2,$3,$3,1,$4,$5,$6,$7,$8,$9,$10)`,
			itemID, idx, baseQty, "M"+f.suffix, "投影物料-"+f.suffix, "EA"+f.suffix,
			orderID, f.companyID, f.materialID, f.unitID)
	case SidePurchase:
		_, err = tx.Exec(ctx, `INSERT INTO pur_order_item(
			id,idx,qty,base_qty,price,material_code,material_name,unit_name,
			order_id,company_id,material_id,unit_id,demand_line_id)
			VALUES($1,$2,$3,$3,1,$4,$5,$6,$7,$8,$9,$10,$11)`,
			itemID, idx, baseQty, "M"+f.suffix, "投影物料-"+f.suffix, "EA"+f.suffix,
			orderID, f.companyID, f.materialID, f.unitID, demandLineID)
	default:
		t.Fatalf("unsupported projection side %q", side)
	}
	if err != nil {
		t.Fatal(err)
	}
}

func requireProjectionQuantity(
	t *testing.T,
	ctx context.Context,
	queryer projectionQueryer,
	table string,
	column string,
	id uuid.UUID,
	want string,
) {
	t.Helper()
	var got decimal.Decimal
	if err := queryer.QueryRow(ctx,
		`SELECT `+column+` FROM `+table+` WHERE id=$1`, id,
	).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if expected := decimal.RequireFromString(want); !got.Equal(expected) {
		t.Fatalf("%s.%s[%s] = %s, want %s", table, column, id, got, expected)
	}
}

func requireDemandProjection(
	t *testing.T,
	ctx context.Context,
	queryer projectionQueryer,
	id uuid.UUID,
	wantReceived string,
	wantStatus string,
) {
	t.Helper()
	var received decimal.Decimal
	var status string
	if err := queryer.QueryRow(ctx,
		`SELECT received_qty,status FROM mfg_demand_item WHERE id=$1`, id,
	).Scan(&received, &status); err != nil {
		t.Fatal(err)
	}
	if expected := decimal.RequireFromString(wantReceived); !received.Equal(expected) ||
		status != wantStatus {
		t.Fatalf("demand projection = (%s, %s), want (%s, %s)",
			received, status, expected, wantStatus)
	}
}
