package orderflow

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/testutil"
)

func TestPostgresOrderFlowReadPermissionORAndCompanyScope(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	pool := testutil.NewPool(t, ctx)
	fixture := seedOrderFlowFixture(t, ctx, pool)
	t.Cleanup(func() { fixture.cleanup(pool) })
	service := NewService(pool)

	for _, permission := range sourceReadPermissions {
		actor := fixture.actor(permission)
		result, err := service.List(ctx, actor, ListQuery{Limit: 10, OrderID: &fixture.orderID})
		if err != nil {
			t.Fatalf("%s List: %v", permission, err)
		}
		if result.Count != 1 || len(result.Results) != 1 {
			t.Fatalf("%s List = %#v", permission, result)
		}
		item := result.Results[0]
		if item.ID != fixture.flowID || item.FlowType != "SALES_DELIVERY" ||
			item.Status != "DRAFT" || item.VoucherNo != fixture.deliveryNo ||
			item.VoucherDate.Format("2006-01-02") != "2026-07-25" ||
			item.MaterialName != fixture.materialName || item.UnitName != fixture.unitName ||
			!item.Qty.Equal(fixture.qty) || item.OrderItemID != fixture.orderItemID ||
			item.CompanyID != fixture.companyID {
			t.Fatalf("%s item = %#v", permission, item)
		}
		got, err := service.Get(ctx, actor, fixture.flowID)
		if err != nil || got.ID != fixture.flowID {
			t.Fatalf("%s Get = %#v, %v", permission, got, err)
		}
		for prefix := range flowPrefixes {
			_, err := service.Get(ctx, actor, prefix+":"+uuid.NewString())
			if errorCode(err) != apierror.CodeNotFound {
				t.Fatalf("%s accepted-prefix %s Get error = %#v", permission, prefix, err)
			}
		}
	}

	outsider := &authz.Actor{
		UserID: uuid.New(), Username: "order-flow-outsider",
		Permissions: map[string]struct{}{"sales.delivery:read": {}},
		CompanyIDs:  []uuid.UUID{fixture.otherCompanyID},
	}
	result, err := service.List(ctx, outsider, ListQuery{Limit: 10, OrderID: &fixture.orderID})
	if err != nil || result.Count != 0 || len(result.Results) != 0 {
		t.Fatalf("out-of-scope List = %#v, %v", result, err)
	}
	if _, err := service.Get(ctx, outsider, fixture.flowID); errorCode(err) != apierror.CodeNotFound {
		t.Fatalf("out-of-scope Get error = %#v", err)
	}
}

type orderFlowFixture struct {
	currencyID, companyID, otherCompanyID uuid.UUID
	customerID, accountDebitID            uuid.UUID
	accountCreditID, unitID, categoryID   uuid.UUID
	materialID, warehouseID               uuid.UUID
	orderID, orderItemID                  uuid.UUID
	deliveryID, deliveryItemID            uuid.UUID
	flowID, deliveryNo                    string
	materialName, unitName                string
	qty                                   decimal.Decimal
}

func seedOrderFlowFixture(t *testing.T, ctx context.Context, pool *pgxpool.Pool) *orderFlowFixture {
	t.Helper()
	suffix := strings.ToUpper(strings.ReplaceAll(uuid.NewString(), "-", "")[:10])
	f := &orderFlowFixture{
		deliveryNo: "SD-OF-" + suffix, materialName: "订单流测试物料-" + suffix,
		unitName: "订单流测试单位-" + suffix, qty: decimal.RequireFromString("3.250000"),
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO bas_currency(name,iso_code,active) VALUES($1,$2,true) RETURNING id
	`, "订单流测试币-"+suffix, "O"+suffix[:2]).Scan(&f.currencyID); err != nil {
		t.Fatal(err)
	}
	for code, target := range map[string]*uuid.UUID{"OF": &f.companyID, "OO": &f.otherCompanyID} {
		if err := pool.QueryRow(ctx, `
			INSERT INTO bas_company(code,name,short_name,base_currency_id)
			VALUES($1,$2,$3,$4) RETURNING id
		`, code+suffix, "订单流测试公司-"+code+suffix, code+suffix, f.currencyID).Scan(target); err != nil {
			t.Fatal(err)
		}
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO sal_customers(code,name) VALUES($1,$2) RETURNING id
	`, "CUS-OF-"+suffix, "订单流测试客户-"+suffix).Scan(&f.customerID); err != nil {
		t.Fatal(err)
	}
	for code, target := range map[string]*uuid.UUID{"OD": &f.accountDebitID, "OC": &f.accountCreditID} {
		if err := pool.QueryRow(ctx, `
			INSERT INTO bas_account(code,name,direction,company_id)
			VALUES($1,$2,'debit',$3) RETURNING id
		`, code+suffix, "订单流测试科目-"+code+suffix, f.companyID).Scan(target); err != nil {
			t.Fatal(err)
		}
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO bas_unit(unit_type,name,symbol,ratio)
		VALUES('quantity',$1,$2,1) RETURNING id
	`, f.unitName, "ofu-"+strings.ToLower(suffix)).Scan(&f.unitID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO inv_material_category(code,name) VALUES($1,$2) RETURNING id
	`, "OFC-"+suffix, "订单流测试分类-"+suffix).Scan(&f.categoryID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO inv_material(code,name,category_id,default_unit_id)
		VALUES($1,$2,$3,$4) RETURNING id
	`, "OFM-"+suffix, f.materialName, f.categoryID, f.unitID).Scan(&f.materialID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO inv_warehouse(name,company_id) VALUES($1,$2) RETURNING id
	`, "订单流测试仓-"+suffix, f.companyID).Scan(&f.warehouseID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO sal_order(
			order_no,order_date,party_type,party_id,status,company_id,currency_id,order_type
		) VALUES($1,'2026-07-20','customer',$2,'audited',$3,$4,'regular')
		RETURNING id
	`, "SO-OF-"+suffix, f.customerID, f.companyID, f.currencyID).Scan(&f.orderID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO sal_order_item(
			idx,qty,price,amount,tax_rate,order_id,company_id,material_id,unit_id,
			material_code,material_name,unit_name,base_price,base_amount,base_qty
		) VALUES(1,10,100,1000,0.13,$1,$2,$3,$4,$5,$6,$7,100,1000,10)
		RETURNING id
	`, f.orderID, f.companyID, f.materialID, f.unitID, "OFM-"+suffix,
		f.materialName, f.unitName).Scan(&f.orderItemID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO sal_delivery(
			delivery_no,delivery_date,party_type,party_id,status,company_id,warehouse_id,
			debit_account_id,credit_account_id
		) VALUES($1,'2026-07-25','customer',$2,'draft',$3,$4,$5,$6)
		RETURNING id
	`, f.deliveryNo, f.customerID, f.companyID, f.warehouseID,
		f.accountDebitID, f.accountCreditID).Scan(&f.deliveryID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO sal_delivery_item(
			idx,qty,base_qty,material_code,material_name,unit_name,order_no,
			order_qty,order_base_qty,order_unit_name,order_price,order_amount,
			order_base_price,order_base_amount,order_tax_rate,order_currency_code,
			delivery_id,company_id,order_item_id,material_id,unit_id,warehouse_id
		) VALUES(
			1,$1,$1,$2,$3,$4,$5,10,10,$4,100,1000,100,1000,0.13,$6,
			$7,$8,$9,$10,$11,$12
		) RETURNING id
	`, f.qty, "OFM-"+suffix, f.materialName, f.unitName, "SO-OF-"+suffix,
		"O"+suffix[:2], f.deliveryID, f.companyID, f.orderItemID, f.materialID,
		f.unitID, f.warehouseID).Scan(&f.deliveryItemID); err != nil {
		t.Fatal(err)
	}
	f.flowID = "sales_delivery:" + f.deliveryItemID.String()
	return f
}

func (f *orderFlowFixture) actor(permission string) *authz.Actor {
	return &authz.Actor{
		UserID: uuid.New(), Username: "order-flow-pg-test",
		Permissions: map[string]struct{}{permission: {}},
		CompanyIDs:  []uuid.UUID{f.companyID},
	}
}

func (f *orderFlowFixture) cleanup(pool *pgxpool.Pool) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_, _ = pool.Exec(ctx, `DELETE FROM sal_delivery_item WHERE id=$1`, f.deliveryItemID)
	_, _ = pool.Exec(ctx, `DELETE FROM sal_delivery WHERE id=$1`, f.deliveryID)
	_, _ = pool.Exec(ctx, `DELETE FROM sal_order_item WHERE id=$1`, f.orderItemID)
	_, _ = pool.Exec(ctx, `DELETE FROM sal_order WHERE id=$1`, f.orderID)
	_, _ = pool.Exec(ctx, `DELETE FROM inv_warehouse WHERE id=$1`, f.warehouseID)
	_, _ = pool.Exec(ctx, `DELETE FROM inv_material WHERE id=$1`, f.materialID)
	_, _ = pool.Exec(ctx, `DELETE FROM inv_material_category WHERE id=$1`, f.categoryID)
	_, _ = pool.Exec(ctx, `DELETE FROM bas_unit WHERE id=$1`, f.unitID)
	_, _ = pool.Exec(ctx, `DELETE FROM bas_account WHERE id=ANY($1::uuid[])`,
		[]uuid.UUID{f.accountDebitID, f.accountCreditID})
	_, _ = pool.Exec(ctx, `DELETE FROM sal_customers WHERE id=$1`, f.customerID)
	_, _ = pool.Exec(ctx, `DELETE FROM inv_warehouse WHERE company_id=ANY($1::uuid[])`,
		[]uuid.UUID{f.companyID, f.otherCompanyID})
	_, _ = pool.Exec(ctx, `DELETE FROM bas_company WHERE id=ANY($1::uuid[])`,
		[]uuid.UUID{f.companyID, f.otherCompanyID})
	_, _ = pool.Exec(ctx, `DELETE FROM bas_currency WHERE id=$1`, f.currencyID)
}
