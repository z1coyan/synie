package execution

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/platform/numbering"
)

type testNumberer struct{}

func (testNumberer) NextInTx(
	context.Context, pgx.Tx, numbering.NextInput,
) (string, error) {
	return "AUTO-" + strings.ReplaceAll(uuid.NewString(), "-", "")[:20], nil
}

type executionFixture struct {
	pool        *pgxpool.Pool
	companyID   uuid.UUID
	userID      uuid.UUID
	currencyID  uuid.UUID
	unitID      uuid.UUID
	boxID       uuid.UUID
	categoryID  uuid.UUID
	materialID  uuid.UUID
	warehouseID uuid.UUID
	suffix      string
	settingID   uuid.UUID
	settingOld  decimal.Decimal
	settingMade bool
}

func TestPostgresDemandSalesOccupancyAndConcurrentWorkOrder(t *testing.T) {
	fixture := newExecutionFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	service := NewService(fixture.pool, testNumberer{})
	actor := fixture.actor()

	salesItemID := fixture.insertAuditedSalesItem(t, decimal.NewFromInt(10))
	d1, i1 := fixture.createDemandItem(
		t, service, actor, decimal.NewFromInt(8), FulfillmentMake, &salesItemID,
	)
	d2, _ := fixture.createDemandItem(
		t, service, actor, decimal.NewFromInt(8), FulfillmentMake, &salesItemID,
	)
	var wg sync.WaitGroup
	wg.Add(2)
	results := make(chan error, 2)
	for _, demandID := range []uuid.UUID{d1.ID, d2.ID} {
		go func(id uuid.UUID) {
			defer wg.Done()
			_, err := service.ConfirmDemand(ctx, actor, id)
			results <- err
		}(demandID)
	}
	wg.Wait()
	close(results)
	successes, failures := 0, 0
	for err := range results {
		if err == nil {
			successes++
		} else {
			failures++
		}
	}
	if successes != 1 || failures != 1 {
		t.Fatalf("concurrent confirms: success=%d failure=%d", successes, failures)
	}
	occupancies, err := service.SalesOccupancies(ctx, actor, []uuid.UUID{salesItemID})
	if err != nil {
		t.Fatal(err)
	}
	if len(occupancies) != 1 ||
		!occupancies[0].OccupiedBaseQty.Equal(decimal.NewFromInt(8)) ||
		!occupancies[0].RemainingBaseQty.Equal(decimal.NewFromInt(2)) {
		t.Fatalf("occupancy = %#v", occupancies)
	}

	var confirmedItemID uuid.UUID
	if err := fixture.pool.QueryRow(ctx, `SELECT i.id
		FROM mfg_demand_item i JOIN mfg_demand d ON d.id=i.demand_id
		WHERE i.sales_order_item_id=$1 AND d.status='confirmed'`, salesItemID).
		Scan(&confirmedItemID); err != nil {
		t.Fatal(err)
	}
	if confirmedItemID != i1.ID {
		// Either draft may win; the assertion below uses the actual winner.
		i1.ID = confirmedItemID
	}
	results = make(chan error, 2)
	wg.Add(2)
	for range 2 {
		go func() {
			defer wg.Done()
			no := "WO-" + strings.ReplaceAll(uuid.NewString(), "-", "")[:20]
			_, err := service.CreateWorkOrder(ctx, actor, CreateWorkOrderInput{
				DemandItemID: confirmedItemID, WorkOrderNo: &no,
			})
			results <- err
		}()
	}
	wg.Wait()
	close(results)
	successes, failures = 0, 0
	for err := range results {
		if err == nil {
			successes++
		} else {
			failures++
		}
	}
	if successes != 1 || failures != 1 {
		t.Fatalf("concurrent work-order creates: success=%d failure=%d",
			successes, failures)
	}
	var activeCount int
	var status string
	if err := fixture.pool.QueryRow(ctx, `SELECT
		(SELECT count(*) FROM mfg_work_order WHERE demand_item_id=$1 AND status<>'voided'),
		(SELECT status FROM mfg_demand_item WHERE id=$1)`, confirmedItemID).
		Scan(&activeCount, &status); err != nil {
		t.Fatal(err)
	}
	if activeCount != 1 || status != string(DemandItemScheduled) {
		t.Fatalf("active work orders=%d item status=%s", activeCount, status)
	}
	workOrders, err := service.ListWorkOrders(ctx, actor, ListQuery{
		Filter: map[string]json.RawMessage{
			"demandItemId": fkFilter(confirmedItemID),
		},
		Sort: &filterbuild.Sort{Column: "remainingBaseQty", Direction: "descending"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if workOrders.Count != 1 || len(workOrders.Results) != 1 {
		t.Fatalf("filtered work orders = %#v", workOrders)
	}
}

func TestPostgresDemandItemLifecycleAndPurchaseProjections(t *testing.T) {
	fixture := newExecutionFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	service := NewService(fixture.pool, testNumberer{})
	actor := fixture.actor()

	manualDemand, manualItem := fixture.createDemandItem(
		t, service, actor, decimal.NewFromInt(10), FulfillmentStock, nil,
	)
	if _, err := service.ConfirmDemand(ctx, actor, manualDemand.ID); err != nil {
		t.Fatal(err)
	}
	completed, err := service.CompleteDemandItem(ctx, actor, manualItem.ID)
	if err != nil {
		t.Fatal(err)
	}
	if completed.Status != DemandItemCompleted {
		t.Fatalf("manual completed status = %s", completed.Status)
	}

	buyDemand, buyItem := fixture.createDemandItem(
		t, service, actor, decimal.NewFromInt(10), FulfillmentBuy, nil,
	)
	if _, err := service.ConfirmDemand(ctx, actor, buyDemand.ID); err != nil {
		t.Fatal(err)
	}
	tx, err := fixture.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := AdjustDemandOrderedInTx(ctx, tx, buyItem.ID,
		decimal.NewFromInt(5)); err != nil {
		tx.Rollback(ctx)
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := service.CompleteDemandItem(ctx, actor, buyItem.ID); err == nil {
		t.Fatal("an ordered purchase line must wait for receipt projection")
	}
	tx, err = fixture.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := AdjustDemandReceivedInTx(ctx, tx, buyItem.ID,
		decimal.NewFromInt(10)); err != nil {
		tx.Rollback(ctx)
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	var received decimal.Decimal
	var status string
	if err := fixture.pool.QueryRow(ctx, `SELECT received_qty,status
		FROM mfg_demand_item WHERE id=$1`, buyItem.ID).Scan(&received, &status); err != nil {
		t.Fatal(err)
	}
	if !received.Equal(decimal.NewFromInt(10)) || status != "completed" {
		t.Fatalf("received=%s status=%s", received, status)
	}
	tx, err = fixture.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := AdjustDemandReceivedInTx(ctx, tx, buyItem.ID,
		decimal.NewFromInt(-10)); err != nil {
		tx.Rollback(ctx)
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := fixture.pool.QueryRow(ctx, `SELECT received_qty,status
		FROM mfg_demand_item WHERE id=$1`, buyItem.ID).Scan(&received, &status); err != nil {
		t.Fatal(err)
	}
	if !received.IsZero() || status != "pending" {
		t.Fatalf("reversed received=%s status=%s", received, status)
	}
	gotItem, err := service.GetDemandItem(ctx, actor, buyItem.ID)
	if err != nil || gotItem.ID != buyItem.ID {
		t.Fatalf("get demand item=%#v err=%v", gotItem, err)
	}
	buyItems, err := service.ListDemandItems(ctx, actor, ListQuery{
		Search: "制造测试物料",
		Filter: map[string]json.RawMessage{
			"fulfillmentMethod": json.RawMessage(
				`{"kind":"enum","values":["BUY"]}`,
			),
		},
		Sort: &filterbuild.Sort{Column: "idx", Direction: "ascending"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if buyItems.Count != 1 || len(buyItems.Results) != 1 ||
		buyItems.Results[0].ID != buyItem.ID {
		t.Fatalf("filtered demand items = %#v", buyItems)
	}

	makeDemand, makeItem := fixture.createDemandItem(
		t, service, actor, decimal.NewFromInt(10), FulfillmentMake, nil,
	)
	if _, err := service.ConfirmDemand(ctx, actor, makeDemand.ID); err != nil {
		t.Fatal(err)
	}
	changed, err := service.ChangeFulfillment(ctx, actor, makeItem.ID, FulfillmentBuy)
	if err != nil || changed.FulfillmentMethod != FulfillmentBuy {
		t.Fatalf("change to buy: item=%#v err=%v", changed, err)
	}
	if _, err := service.ChangeFulfillment(ctx, actor, makeItem.ID,
		FulfillmentMake); err != nil {
		t.Fatal(err)
	}
	no := fixture.no("WO")
	workOrder, err := service.CreateWorkOrder(ctx, actor, CreateWorkOrderInput{
		DemandItemID: makeItem.ID, WorkOrderNo: &no,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.ChangeFulfillment(ctx, actor, makeItem.ID,
		FulfillmentStock); err == nil {
		t.Fatal("active work order must lock fulfillment method")
	}
	if _, err := service.VoidWorkOrder(ctx, actor, workOrder.ID); err != nil {
		t.Fatal(err)
	}
	changed, err = service.ChangeFulfillment(ctx, actor, makeItem.ID, FulfillmentStock)
	if err != nil || changed.Status != DemandItemPending {
		t.Fatalf("change after void: item=%#v err=%v", changed, err)
	}
}

func TestPostgresOutputAtomicProjectionConcurrencyToleranceAndNegativeVoid(t *testing.T) {
	fixture := newExecutionFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	service := NewService(fixture.pool, testNumberer{})
	actor := fixture.actor()
	demand, item := fixture.createDemandItem(
		t, service, actor, decimal.NewFromInt(10), FulfillmentMake, nil,
	)
	if _, err := service.ConfirmDemand(ctx, actor, demand.ID); err != nil {
		t.Fatal(err)
	}
	woNo := fixture.no("WO")
	workOrder, err := service.CreateWorkOrder(ctx, actor, CreateWorkOrderInput{
		DemandItemID: item.ID, WorkOrderNo: &woNo,
	})
	if err != nil {
		t.Fatal(err)
	}

	output1, _ := fixture.createOutput(t, service, actor, workOrder.ID, decimal.NewFromInt(6))
	outputs, err := service.ListOutputs(ctx, actor, ListQuery{
		Filter: map[string]json.RawMessage{
			"outputNo": textEqualFilter(output1.OutputNo),
		},
	})
	if err != nil || outputs.Count != 1 || len(outputs.Results) != 1 {
		t.Fatalf("filtered outputs=%#v err=%v", outputs, err)
	}
	outputItems, err := service.ListOutputItems(ctx, actor, ListQuery{
		Filter: map[string]json.RawMessage{
			"outputId": fkFilter(output1.ID),
		},
	})
	if err != nil || outputItems.Count != 1 || len(outputItems.Results) != 1 {
		t.Fatalf("filtered output items=%#v err=%v", outputItems, err)
	}
	gotOutputItem, err := service.GetOutputItem(ctx, actor, outputItems.Results[0].ID)
	if err != nil || gotOutputItem.OutputID != output1.ID {
		t.Fatalf("get output item=%#v err=%v", gotOutputItem, err)
	}
	var wg sync.WaitGroup
	results := make(chan error, 2)
	wg.Add(2)
	for range 2 {
		go func() {
			defer wg.Done()
			_, err := service.AuditOutput(ctx, actor, output1.ID)
			results <- err
		}()
	}
	wg.Wait()
	close(results)
	successes, failures := 0, 0
	for err := range results {
		if err == nil {
			successes++
		} else {
			failures++
		}
	}
	if successes != 1 || failures != 1 {
		t.Fatalf("double audit: success=%d failure=%d", successes, failures)
	}
	fixture.assertProjection(t, workOrder.ID, item.ID, "6", "in_progress", "scheduled")

	output2, _ := fixture.createOutput(t, service, actor, workOrder.ID, decimal.NewFromInt(5))
	if _, err := service.AuditOutput(ctx, actor, output2.ID); err == nil {
		t.Fatal("zero tolerance must reject cumulative quantity 11 > 10")
	}
	fixture.setOutputRatio(t, "0.2")
	if _, err := service.AuditOutput(ctx, actor, output2.ID); err != nil {
		t.Fatal(err)
	}
	fixture.assertProjection(t, workOrder.ID, item.ID, "11", "completed", "completed")
	if _, err := service.VoidOutput(ctx, actor, output2.ID); err != nil {
		t.Fatal(err)
	}
	fixture.assertProjection(t, workOrder.ID, item.ID, "6", "in_progress", "scheduled")
	fixture.setOutputRatio(t, "0")

	output3, outputItem3 := fixture.createOutput(
		t, service, actor, workOrder.ID, decimal.NewFromInt(3),
	)
	newQty := decimal.NewFromInt(4)
	type raceResult struct {
		action string
		err    error
	}
	raceResults := make(chan raceResult, 2)
	wg.Add(2)
	go func() {
		defer wg.Done()
		_, err := service.AuditOutput(ctx, actor, output3.ID)
		raceResults <- raceResult{action: "audit", err: err}
	}()
	go func() {
		defer wg.Done()
		_, err := service.UpdateOutputItem(ctx, actor, outputItem3.ID,
			UpdateOutputItemInput{Qty: &newQty})
		raceResults <- raceResult{action: "edit", err: err}
	}()
	wg.Wait()
	close(raceResults)
	auditSucceeded := false
	for result := range raceResults {
		if result.action == "audit" && result.err == nil {
			auditSucceeded = true
		}
	}
	if !auditSucceeded {
		t.Fatal("audit must succeed while racing a draft-line edit")
	}
	var lineQty, ledgerQty, received decimal.Decimal
	if err := fixture.pool.QueryRow(ctx, `SELECT base_qty FROM mfg_output_item WHERE id=$1`,
		outputItem3.ID).Scan(&lineQty); err != nil {
		t.Fatal(err)
	}
	if err := fixture.pool.QueryRow(ctx, `SELECT quantity FROM inv_stock_entry
		WHERE voucher_type='mfg.output' AND voucher_id=$1 AND is_cancelled=false`,
		output3.ID).Scan(&ledgerQty); err != nil {
		t.Fatal(err)
	}
	if err := fixture.pool.QueryRow(ctx, `SELECT received_base_qty FROM mfg_work_order
		WHERE id=$1`, workOrder.ID).Scan(&received); err != nil {
		t.Fatal(err)
	}
	if !ledgerQty.Equal(lineQty) || !received.Equal(decimal.NewFromInt(6).Add(lineQty)) {
		t.Fatalf("line=%s ledger=%s received=%s", lineQty, ledgerQty, received)
	}

	var balance decimal.Decimal
	if err := fixture.pool.QueryRow(ctx, `SELECT coalesce(sum(quantity),0)
		FROM inv_stock_entry WHERE warehouse_id=$1 AND material_id=$2
		AND is_cancelled=false`, fixture.warehouseID, fixture.materialID).Scan(&balance); err != nil {
		t.Fatal(err)
	}
	consumeID := uuid.New()
	if _, err := fixture.pool.Exec(ctx, `INSERT INTO inv_stock_entry (
		quantity,posting_date,voucher_type,voucher_id,voucher_no,is_cancelled,
		company_id,warehouse_id,material_id
	) VALUES ($1,CURRENT_DATE,'test.consume',$2,$3,false,$4,$5,$6)`,
		balance.Neg(), consumeID, fixture.no("USE"), fixture.companyID,
		fixture.warehouseID, fixture.materialID); err != nil {
		t.Fatal(err)
	}
	if _, err := service.VoidOutput(ctx, actor, output1.ID); err == nil {
		t.Fatal("void must reject when cancelling the receipt would make stock negative")
	}
	var outputStatus string
	if err := fixture.pool.QueryRow(ctx, `SELECT status FROM mfg_output WHERE id=$1`,
		output1.ID).Scan(&outputStatus); err != nil {
		t.Fatal(err)
	}
	if outputStatus != "audited" {
		t.Fatalf("failed void changed output status to %s", outputStatus)
	}
}

func fkFilter(id uuid.UUID) json.RawMessage {
	raw, _ := json.Marshal(map[string]any{
		"kind": "fk", "op": "in", "values": []string{id.String()},
	})
	return raw
}

func textEqualFilter(value string) json.RawMessage {
	raw, _ := json.Marshal(map[string]any{
		"kind": "text", "op": "eq", "value": value,
	})
	return raw
}

func (f executionFixture) actor() *authz.Actor {
	return &authz.Actor{
		UserID: f.userID, Username: "mfg-execution-pg-test",
		SuperAdmin: true, CompanyIDs: []uuid.UUID{f.companyID},
	}
}

func (f executionFixture) no(prefix string) string {
	return prefix + "-" + f.suffix + "-" + strings.ReplaceAll(uuid.NewString(), "-", "")[:6]
}

func (f executionFixture) createDemandItem(
	t *testing.T,
	service *Service,
	actor *authz.Actor,
	qty decimal.Decimal,
	method FulfillmentMethod,
	salesItemID *uuid.UUID,
) (Demand, DemandItem) {
	t.Helper()
	ctx := context.Background()
	no := f.no("D")
	demand, err := service.CreateDemand(ctx, actor, CreateDemandInput{
		CompanyID: f.companyID, DemandNo: &no,
	})
	if err != nil {
		t.Fatal(err)
	}
	item, err := service.CreateDemandItem(ctx, actor, CreateDemandItemInput{
		DemandID: demand.ID, Idx: 1, MaterialID: f.materialID,
		UnitID: f.unitID, Qty: qty, FulfillmentMethod: method,
		SalesOrderItemID: salesItemID,
	})
	if err != nil {
		t.Fatal(err)
	}
	return demand, item
}

func (f executionFixture) createOutput(
	t *testing.T,
	service *Service,
	actor *authz.Actor,
	workOrderID uuid.UUID,
	qty decimal.Decimal,
) (Output, OutputItem) {
	t.Helper()
	ctx := context.Background()
	no := f.no("OUT")
	output, err := service.CreateOutput(ctx, actor, CreateOutputInput{
		CompanyID: f.companyID, OutputNo: &no, WarehouseID: &f.warehouseID,
	})
	if err != nil {
		t.Fatal(err)
	}
	item, err := service.CreateOutputItem(ctx, actor, CreateOutputItemInput{
		OutputID: output.ID, Idx: 1, WorkOrderID: workOrderID,
		UnitID: f.unitID, Qty: qty, WarehouseID: f.warehouseID,
	})
	if err != nil {
		t.Fatal(err)
	}
	return output, item
}

func (f executionFixture) assertProjection(
	t *testing.T,
	workOrderID, demandItemID uuid.UUID,
	wantQty, wantWorkStatus, wantItemStatus string,
) {
	t.Helper()
	ctx := context.Background()
	var qty decimal.Decimal
	var workStatus, itemStatus string
	if err := f.pool.QueryRow(ctx, `SELECT w.received_base_qty,w.status,i.status
		FROM mfg_work_order w JOIN mfg_demand_item i ON i.id=w.demand_item_id
		WHERE w.id=$1 AND i.id=$2`, workOrderID, demandItemID).
		Scan(&qty, &workStatus, &itemStatus); err != nil {
		t.Fatal(err)
	}
	if !qty.Equal(decimal.RequireFromString(wantQty)) ||
		workStatus != wantWorkStatus || itemStatus != wantItemStatus {
		t.Fatalf("projection qty=%s work=%s item=%s", qty, workStatus, itemStatus)
	}
}

func (f executionFixture) insertAuditedSalesItem(
	t *testing.T, qty decimal.Decimal,
) uuid.UUID {
	t.Helper()
	ctx := context.Background()
	orderID, itemID := uuid.New(), uuid.New()
	_, err := f.pool.Exec(ctx, `INSERT INTO sal_order (
		id,order_no,order_date,party_type,party_id,status,company_id,
		exchange_rate,currency_id,order_type
	) VALUES ($1,$2,CURRENT_DATE,'customer',$3,'audited',$4,1,$5,'sample')`,
		orderID, f.no("SO"), uuid.New(), f.companyID, f.currencyID)
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.pool.Exec(ctx, `INSERT INTO sal_order_item (
		id,idx,qty,base_qty,price,amount,tax_rate,order_id,company_id,
		material_id,unit_id,material_code,material_name,unit_name,base_price,base_amount
	) VALUES ($1,1,$2,$2,1,$2,0.13,$3,$4,$5,$6,$7,$8,$9,1,$2)`,
		itemID, qty, orderID, f.companyID, f.materialID, f.unitID,
		"MAT-"+f.suffix, "制造测试物料-"+f.suffix, "件-"+f.suffix)
	if err != nil {
		t.Fatal(err)
	}
	return itemID
}

func (f *executionFixture) setOutputRatio(t *testing.T, value string) {
	t.Helper()
	if _, err := f.pool.Exec(context.Background(), `UPDATE mfg_setting
		SET output_overreceive_ratio=$2 WHERE id=$1`,
		f.settingID, decimal.RequireFromString(value)); err != nil {
		t.Fatal(err)
	}
}

func newExecutionFixture(t *testing.T) *executionFixture {
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
	suffix := strings.ReplaceAll(uuid.NewString(), "-", "")[:10]
	f := &executionFixture{
		pool: pool, companyID: uuid.New(), userID: uuid.New(),
		currencyID: uuid.New(), unitID: uuid.New(), boxID: uuid.New(),
		categoryID: uuid.New(), materialID: uuid.New(), warehouseID: uuid.New(),
		suffix: suffix,
	}
	batch := &pgx.Batch{}
	batch.Queue(`INSERT INTO bas_currency (id,name,iso_code,active)
		VALUES ($1,$2,$3,true)`, f.currencyID, "制造测试币-"+suffix, "X"+suffix)
	batch.Queue(`INSERT INTO bas_company (id,code,name,short_name,base_currency_id)
		VALUES ($1,$2,$3,$3,$4)`, f.companyID, "X"+suffix,
		"制造测试公司-"+suffix, f.currencyID)
	batch.Queue(`INSERT INTO sys_user (
		id,username,name,hashed_password,super_admin,all_companies
	) VALUES ($1,$2,$3,'test',true,true)`, f.userID,
		"mfg-"+suffix, "制造测试用户-"+suffix)
	batch.Queue(`INSERT INTO bas_unit (id,unit_type,is_base,name,symbol,ratio)
		VALUES ($1,'quantity',false,$2,$3,1),($4,'quantity',false,$5,$6,1)`,
		f.unitID, "件-"+suffix, "ea"+suffix, f.boxID, "箱-"+suffix, "bx"+suffix)
	batch.Queue(`INSERT INTO inv_material_category (id,code,name,is_leaf,active)
		VALUES ($1,$2,$3,true,true)`, f.categoryID, "MC"+suffix, "制造分类-"+suffix)
	batch.Queue(`INSERT INTO inv_material (
		id,code,name,spec,category_id,default_unit_id
	) VALUES ($1,$2,$3,'MFG',$4,$5)`, f.materialID,
		"MAT-"+suffix, "制造测试物料-"+suffix, f.categoryID, f.unitID)
	batch.Queue(`INSERT INTO inv_material_unit (id,material_id,unit_id,factor)
		VALUES ($1,$2,$3,10)`, uuid.New(), f.materialID, f.boxID)
	batch.Queue(`INSERT INTO inv_warehouse (
		id,name,company_id,is_leaf,active,allow_negative
	) VALUES ($1,$2,$3,true,true,false)`, f.warehouseID,
		"制造测试仓-"+suffix, f.companyID)
	results := pool.SendBatch(ctx, batch)
	if err := results.Close(); err != nil {
		pool.Close()
		t.Fatal(err)
	}
	err = pool.QueryRow(ctx, `SELECT id,output_overreceive_ratio
		FROM mfg_setting ORDER BY inserted_at,id LIMIT 1`).
		Scan(&f.settingID, &f.settingOld)
	if errors.Is(err, pgx.ErrNoRows) {
		f.settingID, f.settingOld, f.settingMade = uuid.New(), decimal.Zero, true
		if _, err := pool.Exec(ctx, `INSERT INTO mfg_setting
			(id,output_overreceive_ratio) VALUES ($1,0)`, f.settingID); err != nil {
			pool.Close()
			t.Fatal(err)
		}
	} else if err != nil {
		pool.Close()
		t.Fatal(err)
	} else {
		f.setOutputRatio(t, "0")
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cleanupCancel()
		steps := []struct {
			sql  string
			args []any
		}{
			{`DELETE FROM sys_audit_log WHERE company_id=$1`, []any{f.companyID}},
			{`DELETE FROM inv_stock_entry WHERE company_id=$1`, []any{f.companyID}},
			{`DELETE FROM mfg_output_item WHERE company_id=$1`, []any{f.companyID}},
			{`DELETE FROM mfg_output WHERE company_id=$1`, []any{f.companyID}},
			{`DELETE FROM mfg_work_order WHERE company_id=$1`, []any{f.companyID}},
			{`DELETE FROM mfg_demand_item WHERE company_id=$1`, []any{f.companyID}},
			{`DELETE FROM mfg_demand WHERE company_id=$1`, []any{f.companyID}},
			{`DELETE FROM sal_order_item WHERE company_id=$1`, []any{f.companyID}},
			{`DELETE FROM sal_order WHERE company_id=$1`, []any{f.companyID}},
			{`DELETE FROM inv_material_unit WHERE material_id=$1`, []any{f.materialID}},
			{`DELETE FROM inv_warehouse WHERE company_id=$1`, []any{f.companyID}},
			{`DELETE FROM inv_material WHERE id=$1`, []any{f.materialID}},
			{`DELETE FROM inv_material_category WHERE id=$1`, []any{f.categoryID}},
			{`DELETE FROM sys_user WHERE id=$1`, []any{f.userID}},
			{`DELETE FROM bas_company WHERE id=$1`, []any{f.companyID}},
			{`DELETE FROM bas_unit WHERE id=ANY($1::uuid[])`, []any{[]uuid.UUID{f.unitID, f.boxID}}},
			{`DELETE FROM bas_currency WHERE id=$1`, []any{f.currencyID}},
		}
		for _, step := range steps {
			if _, err := pool.Exec(cleanupCtx, step.sql, step.args...); err != nil {
				t.Errorf("cleanup %q: %v", step.sql, err)
			}
		}
		if f.settingMade {
			if _, err := pool.Exec(cleanupCtx, `DELETE FROM mfg_setting WHERE id=$1`,
				f.settingID); err != nil {
				t.Errorf("cleanup setting: %v", err)
			}
		} else if _, err := pool.Exec(cleanupCtx, `UPDATE mfg_setting
			SET output_overreceive_ratio=$2 WHERE id=$1`, f.settingID, f.settingOld); err != nil {
			t.Errorf("restore setting: %v", err)
		}
		pool.Close()
	})
	return f
}
