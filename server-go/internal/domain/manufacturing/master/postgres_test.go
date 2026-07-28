package master

import (
	"context"
	"encoding/json"
	"fmt"
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
	"github.com/z1coyan/synie/server/internal/testutil"
)

type testNumberer struct {
	mu   sync.Mutex
	next int
}

func (n *testNumberer) NextInTx(_ context.Context, _ pgx.Tx, input numbering.NextInput) (string, error) {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.next++
	return fmt.Sprintf("%s-%04d", input.Resource, n.next), nil
}

func TestPostgresManufacturingMasterLifecycleAndSnapshots(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	pool := testutil.NewPool(t, ctx)

	fixture := seedManufacturingMasterFixture(t, ctx, pool)
	defer fixture.cleanup(t, pool)

	service := NewService(pool, &testNumberer{})
	actor := &authz.Actor{UserID: uuid.New(), Username: "mfg-master-test", SuperAdmin: true}

	operation, err := service.CreateOperation(ctx, actor, HeadCreateInput{Name: "测试工序"})
	if err != nil {
		t.Fatal(err)
	}
	fixture.operationIDs = append(fixture.operationIDs, operation.ID)
	if operation.Code == "" {
		t.Fatal("operation code was not auto allocated")
	}
	operationList, err := service.ListOperations(ctx, actor, ListQuery{
		Search: "测试工序",
		Sort:   &filterbuild.Sort{Column: "name", Direction: "descending"},
		Filter: map[string]json.RawMessage{
			"name": json.RawMessage(`{"kind":"text","op":"contains","value":"测试"}`),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if operationList.Count != 1 || len(operationList.Results) != 1 ||
		operationList.Results[0].ID != operation.ID {
		t.Fatalf("operation search/filter/sort mismatch: %#v", operationList)
	}

	template, err := service.CreateTemplate(ctx, actor, HeadCreateInput{Name: "测试模板"})
	if err != nil {
		t.Fatal(err)
	}
	fixture.templateIDs = append(fixture.templateIDs, template.ID)
	requirement := "模板原值"
	templateItem, err := service.CreateTemplateItem(ctx, actor, template.ID, RouteItemInput{
		OperationID: operation.ID, Seq: 10, Requirement: &requirement, IsOutsourced: true,
	})
	if err != nil {
		t.Fatal(err)
	}

	first, err := service.CreateBOM(ctx, actor, BOMCreateInput{
		MaterialID: fixture.parentMaterialID, PlanName: ptr("内制"),
	})
	if err != nil {
		t.Fatal(err)
	}
	fixture.bomIDs = append(fixture.bomIDs, first.ID)
	second, err := service.CreateBOM(ctx, actor, BOMCreateInput{
		MaterialID: fixture.parentMaterialID, PlanName: ptr("委外"),
	})
	if err != nil {
		t.Fatalf("same material should allow multiple BOM plans: %v", err)
	}
	fixture.bomIDs = append(fixture.bomIDs, second.ID)
	if first.Code == second.Code {
		t.Fatalf("BOM codes must remain unique: %q", first.Code)
	}

	routes, err := service.ApplyRouteTemplate(ctx, actor, first.ID, template.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(routes) != 1 || routes[0].Requirement == nil || *routes[0].Requirement != "模板原值" {
		t.Fatalf("unexpected copied routes: %#v", routes)
	}
	changed := "模板后改"
	if _, err := service.UpdateTemplateItem(ctx, actor, templateItem.ID, RouteItemInput{
		OperationID: operation.ID, Seq: 99, Requirement: &changed,
	}); err != nil {
		t.Fatal(err)
	}
	copied, err := service.GetBOMRoute(ctx, actor, routes[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	if copied.Seq != 10 || copied.Requirement == nil || *copied.Requirement != "模板原值" {
		t.Fatalf("BOM route was not a detached snapshot: %#v", copied)
	}
	if _, err := service.ApplyRouteTemplate(ctx, actor, first.ID, template.ID); !isCode(err, apierror.CodeConflict) {
		t.Fatalf("non-empty route should reject template copy: %v", err)
	}
	if err := service.DeleteOperation(ctx, actor, operation.ID); !isCode(err, apierror.CodeConflict) {
		t.Fatalf("referenced operation should not be deletable: %v", err)
	}

	component, err := service.CreateBOMComponent(ctx, actor, ComponentInput{
		BOMID: first.ID, MaterialID: fixture.childMaterialID, UnitID: fixture.defaultUnitID,
		Quantity: decimal.RequireFromString("2.5"), LossRate: decimalPtr("0.1"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := ComponentApplyQuantity(component, decimal.NewFromInt(4)); !got.Equal(decimal.NewFromInt(11)) {
		t.Fatalf("component apply quantity = %s, want 11", got)
	}
	if _, err := service.CreateBOMComponent(ctx, actor, ComponentInput{
		BOMID: first.ID, MaterialID: fixture.parentMaterialID, UnitID: fixture.defaultUnitID,
		Quantity: decimal.NewFromInt(1),
	}); !isCode(err, apierror.CodeValidation) {
		t.Fatalf("self material should fail: %v", err)
	}
	if _, err := service.CreateBOMComponent(ctx, actor, ComponentInput{
		BOMID: first.ID, MaterialID: fixture.childMaterialID, UnitID: fixture.unrelatedUnitID,
		Quantity: decimal.NewFromInt(1),
	}); !isCode(err, apierror.CodeValidation) {
		t.Fatalf("unrelated unit should fail: %v", err)
	}
	if _, err := service.CreateBOMComponent(ctx, actor, ComponentInput{
		BOMID: first.ID, MaterialID: fixture.childMaterialID, UnitID: fixture.convertedUnitID,
		Quantity: decimal.NewFromInt(1),
	}); err != nil {
		t.Fatalf("material conversion unit should be accepted: %v", err)
	}
	componentList, err := service.ListBOMComponents(ctx, actor, &first.ID, ListQuery{
		Sort: &filterbuild.Sort{Column: "quantity", Direction: "descending"},
		Filter: map[string]json.RawMessage{
			"materialId": json.RawMessage(fmt.Sprintf(
				`{"kind":"fk","op":"in","values":[%q]}`, fixture.childMaterialID)),
			"quantity": json.RawMessage(`{"kind":"number","op":"gte","value":"1"}`),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if componentList.Count != 2 || len(componentList.Results) != 2 ||
		componentList.Results[0].Quantity.LessThan(componentList.Results[1].Quantity) {
		t.Fatalf("component FK/number filter or sort mismatch: %#v", componentList)
	}
	if _, err := service.CreateBOMByproduct(ctx, actor, ByproductInput{
		BOMID: first.ID, MaterialID: fixture.childMaterialID, UnitID: fixture.defaultUnitID,
		Quantity: decimal.RequireFromString("0.2"),
	}); err != nil {
		t.Fatal(err)
	}

	concurrentBOM, err := service.CreateBOM(ctx, actor, BOMCreateInput{
		MaterialID: fixture.parentMaterialID, PlanName: ptr("并发"),
	})
	if err != nil {
		t.Fatal(err)
	}
	fixture.bomIDs = append(fixture.bomIDs, concurrentBOM.ID)
	start := make(chan struct{})
	results := make(chan error, 2)
	for range 2 {
		go func() {
			<-start
			_, copyErr := service.ApplyRouteTemplate(context.Background(), actor, concurrentBOM.ID, template.ID)
			results <- copyErr
		}()
	}
	close(start)
	successes, conflicts := 0, 0
	for range 2 {
		copyErr := <-results
		switch {
		case copyErr == nil:
			successes++
		case isCode(copyErr, apierror.CodeConflict):
			conflicts++
		default:
			t.Fatalf("unexpected concurrent copy error: %v", copyErr)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("concurrent copies: successes=%d conflicts=%d", successes, conflicts)
	}

	if err := service.DeleteBOM(ctx, actor, first.ID); err != nil {
		t.Fatal(err)
	}
	fixture.bomIDs = removeUUID(fixture.bomIDs, first.ID)
	var childCount int
	if err := pool.QueryRow(ctx, `SELECT
		(SELECT count(*) FROM mfg_bom_component WHERE bom_id=$1)+
		(SELECT count(*) FROM mfg_bom_route WHERE bom_id=$1)+
		(SELECT count(*) FROM mfg_bom_byproduct WHERE bom_id=$1)`, first.ID).Scan(&childCount); err != nil {
		t.Fatal(err)
	}
	if childCount != 0 {
		t.Fatalf("BOM delete did not cascade all child rows: %d", childCount)
	}
}

type manufacturingMasterFixture struct {
	categoryID, defaultUnitID, convertedUnitID, unrelatedUnitID uuid.UUID
	parentMaterialID, childMaterialID                           uuid.UUID
	operationIDs, templateIDs, bomIDs                           []uuid.UUID
}

func seedManufacturingMasterFixture(t *testing.T, ctx context.Context, pool *pgxpool.Pool) *manufacturingMasterFixture {
	t.Helper()
	suffix := uuid.NewString()
	f := &manufacturingMasterFixture{
		categoryID: uuid.New(), defaultUnitID: uuid.New(), convertedUnitID: uuid.New(),
		unrelatedUnitID: uuid.New(), parentMaterialID: uuid.New(), childMaterialID: uuid.New(),
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `INSERT INTO inv_material_category(id,code,name)
		VALUES($1,$2,$3)`, f.categoryID, "MFG-CAT-"+suffix, "制造测试分类"+suffix); err != nil {
		t.Fatal(err)
	}
	for _, row := range []struct {
		id     uuid.UUID
		symbol string
	}{
		{f.defaultUnitID, "MFG-D-" + suffix},
		{f.convertedUnitID, "MFG-C-" + suffix},
		{f.unrelatedUnitID, "MFG-X-" + suffix},
	} {
		if _, err := tx.Exec(ctx, `INSERT INTO bas_unit(id,unit_type,is_base,name,symbol,ratio)
			VALUES($1,'quantity',false,$2,$3,1)`, row.id, "制造测试单位"+row.symbol, row.symbol); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := tx.Exec(ctx, `INSERT INTO inv_material(id,code,name,category_id,default_unit_id)
		VALUES($1,$2,$3,$4,$5),($6,$7,$8,$4,$5)`,
		f.parentMaterialID, "MFG-P-"+suffix, "制造测试母料"+suffix, f.categoryID, f.defaultUnitID,
		f.childMaterialID, "MFG-C-"+suffix, "制造测试子料"+suffix); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO inv_material_unit(material_id,unit_id,factor)
		VALUES($1,$2,2)`, f.childMaterialID, f.convertedUnitID); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	return f
}

func (f *manufacturingMasterFixture) cleanup(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	for _, id := range f.bomIDs {
		if _, err := pool.Exec(ctx, `DELETE FROM mfg_bom WHERE id=$1`, id); err != nil {
			t.Errorf("cleanup BOM %s: %v", id, err)
		}
	}
	for _, id := range f.templateIDs {
		if _, err := pool.Exec(ctx, `DELETE FROM mfg_process_template WHERE id=$1`, id); err != nil {
			t.Errorf("cleanup template %s: %v", id, err)
		}
	}
	for _, id := range f.operationIDs {
		if _, err := pool.Exec(ctx, `DELETE FROM mfg_operation WHERE id=$1`, id); err != nil {
			t.Errorf("cleanup operation %s: %v", id, err)
		}
	}
	if _, err := pool.Exec(ctx, `DELETE FROM sys_audit_log WHERE actor_name='mfg-master-test'`); err != nil {
		t.Errorf("cleanup audit: %v", err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM inv_material WHERE id=ANY($1::uuid[])`,
		[]uuid.UUID{f.parentMaterialID, f.childMaterialID}); err != nil {
		t.Errorf("cleanup materials: %v", err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM inv_material_category WHERE id=$1`, f.categoryID); err != nil {
		t.Errorf("cleanup category: %v", err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM bas_unit WHERE id=ANY($1::uuid[])`,
		[]uuid.UUID{f.defaultUnitID, f.convertedUnitID, f.unrelatedUnitID}); err != nil {
		t.Errorf("cleanup units: %v", err)
	}
}

func decimalPtr(value string) *decimal.Decimal {
	result := decimal.RequireFromString(value)
	return &result
}

func removeUUID(values []uuid.UUID, target uuid.UUID) []uuid.UUID {
	result := values[:0]
	for _, value := range values {
		if value != target {
			result = append(result, value)
		}
	}
	return result
}
