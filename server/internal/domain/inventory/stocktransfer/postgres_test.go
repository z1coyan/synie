package stocktransfer

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/db/dbgen"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/platform/numbering"
)

type fixedTxNumberer struct {
	number string
	called bool
}

func (n *fixedTxNumberer) NextInTx(ctx context.Context, tx pgx.Tx, _ numbering.NextInput) (string, error) {
	n.called = true
	var one int
	if err := tx.QueryRow(ctx, "SELECT 1").Scan(&one); err != nil {
		return "", err
	}
	return n.number, nil
}

func TestPostgresStockTransferLifecycle(t *testing.T) {
	f := newTransferFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	actor := &authz.Actor{
		UserID: f.userID, Username: "stock-transfer-pg",
		SuperAdmin: true, CompanyIDs: []uuid.UUID{f.companyID},
	}
	numberer := &fixedTxNumberer{number: "AUTO-" + strings.ReplaceAll(uuid.NewString(), "-", "")[:20]}
	service := NewService(f.pool, numberer)
	summary := "车间转仓"
	doc, err := service.Create(ctx, actor, CreateInput{
		CompanyID: f.companyID, FromWarehouseID: f.fromID,
		ToWarehouseID: f.toID, TransitWarehouseID: f.transitID, Summary: &summary,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !numberer.called || doc.Status != StatusDraft || doc.DocNo != numberer.number {
		t.Fatalf("created = %#v numberer=%v", doc, numberer.called)
	}
	item, err := service.CreateItem(ctx, actor, CreateItemInput{
		StockTransferID: doc.ID, Idx: 1, Qty: decimal.NewFromInt(4),
		MaterialID: f.materialID, UnitID: f.unitID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !item.BaseQty.Equal(decimal.NewFromInt(4)) || item.ReceivedQty != nil ||
		item.CompanyID != f.companyID || item.MaterialCode == "" {
		t.Fatalf("created item = %#v", item)
	}
	shipped, err := service.Ship(ctx, actor, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	if shipped.Status != StatusShipped || shipped.ShippedAt == nil {
		t.Fatalf("shipped = %#v", shipped)
	}
	assertVoucherEntryCount(t, ctx, f, doc.ID, 2)
	assertBalance(t, ctx, f, f.fromID, decimal.NewFromInt(96))
	assertBalance(t, ctx, f, f.transitID, decimal.NewFromInt(4))
	newQty := decimal.NewFromInt(3)
	if _, err := service.UpdateItem(ctx, actor, item.ID, UpdateItemInput{Qty: &newQty}); err == nil {
		t.Fatal("shipped item update must fail")
	}

	// “停用拦新不拦旧”: after shipping, receipt does not re-check active.
	if _, err := f.pool.Exec(ctx, "UPDATE inv_warehouse SET active=false WHERE id=$1", f.toID); err != nil {
		t.Fatal(err)
	}
	received, err := service.Receive(ctx, actor, doc.ID, ReceiveInput{})
	if err != nil {
		t.Fatal(err)
	}
	if received.Status != StatusReceived || received.ReceivedAt == nil {
		t.Fatalf("received = %#v", received)
	}
	assertVoucherEntryCount(t, ctx, f, doc.ID, 4)
	assertBalance(t, ctx, f, f.transitID, decimal.Zero)
	assertBalance(t, ctx, f, f.toID, decimal.NewFromInt(4))
	stored, err := service.GetItem(ctx, actor, item.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.ReceivedQty == nil || !stored.ReceivedQty.Equal(decimal.NewFromInt(4)) {
		t.Fatalf("received qty = %v", stored.ReceivedQty)
	}
	if err := service.Delete(ctx, actor, doc.ID); err == nil {
		t.Fatal("received transfer delete must fail")
	}

	var actions []string
	rows, err := f.pool.Query(ctx, `SELECT action_name FROM sys_audit_log
		WHERE resource='inv_stock_transfer' AND record_id=$1 ORDER BY inserted_at,id`, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var action string
		if err := rows.Scan(&action); err != nil {
			rows.Close()
			t.Fatal(err)
		}
		actions = append(actions, action)
	}
	rows.Close()
	if strings.Join(actions, ",") != "create,ship,receive" {
		t.Fatalf("head audit actions = %#v", actions)
	}
	var actorID *uuid.UUID
	if err := f.pool.QueryRow(ctx, `SELECT actor_id FROM sys_audit_log
		WHERE resource='inv_stock_transfer_item' AND record_id=$1 AND action_name='write_received'`,
		item.ID).Scan(&actorID); err != nil {
		t.Fatal(err)
	}
	if actorID != nil {
		t.Fatalf("write_received actor = %v, want nil", actorID)
	}
}

func TestPostgresStockTransferWarehouseValidation(t *testing.T) {
	f := newTransferFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	actor := &authz.Actor{SuperAdmin: true, CompanyIDs: []uuid.UUID{f.companyID}}
	service := NewService(f.pool, &fixedTxNumberer{number: "DISTINCT-" + uuid.NewString()[:8]})
	_, err := service.Create(ctx, actor, CreateInput{
		CompanyID: f.companyID, FromWarehouseID: f.fromID,
		ToWarehouseID: f.fromID, TransitWarehouseID: f.transitID,
	})
	if !hasFieldMessage(err, "两两不同") {
		t.Fatalf("distinct validation error = %v", err)
	}
	if _, err := f.pool.Exec(ctx, "UPDATE inv_warehouse SET active=false WHERE id=$1", f.transitID); err != nil {
		t.Fatal(err)
	}
	_, err = service.Create(ctx, actor, CreateInput{
		CompanyID: f.companyID, FromWarehouseID: f.fromID,
		ToWarehouseID: f.toID, TransitWarehouseID: f.transitID,
	})
	if !hasFieldMessage(err, "仓库已停用") {
		t.Fatalf("active validation error = %v", err)
	}
}

func hasFieldMessage(err error, want string) bool {
	var target *apierror.Error
	if !errors.As(err, &target) {
		return false
	}
	for _, messages := range target.Fields {
		for _, message := range messages {
			if strings.Contains(message, want) {
				return true
			}
		}
	}
	return false
}

func TestResolveReceiptsContract(t *testing.T) {
	first, second, foreign := uuid.New(), uuid.New(), uuid.New()
	items := []dbgen.InvStockTransferItem{
		{ID: first, Idx: 1, BaseQty: decimal.NewFromInt(4)},
		{ID: second, Idx: 2, BaseQty: decimal.NewFromInt(5)},
	}
	full, err := resolveReceipts(items, nil)
	if err != nil || !full[0].qty.Equal(decimal.NewFromInt(4)) ||
		!full[1].qty.Equal(decimal.NewFromInt(5)) {
		t.Fatalf("default full receipt = %#v, %v", full, err)
	}
	partial, err := resolveReceipts(items, []Receipt{
		{ItemID: first, Qty: decimal.NewFromInt(3)},
		{ItemID: second, Qty: decimal.Zero},
	})
	if err != nil || !partial[0].qty.Equal(decimal.NewFromInt(3)) || !partial[1].qty.IsZero() {
		t.Fatalf("partial/zero receipt = %#v, %v", partial, err)
	}
	cases := []struct {
		name     string
		receipts []Receipt
		want     string
	}{
		{"missing", []Receipt{{ItemID: first, Qty: decimal.NewFromInt(4)}}, "覆盖全部行"},
		{"foreign", []Receipt{{ItemID: foreign, Qty: decimal.NewFromInt(1)}}, "不属于本调拨单"},
		{"negative", []Receipt{{ItemID: first, Qty: decimal.NewFromInt(-1)}, {ItemID: second, Qty: decimal.Zero}}, "必须在 0"},
		{"over", []Receipt{{ItemID: first, Qty: decimal.NewFromInt(5)}, {ItemID: second, Qty: decimal.Zero}}, "必须在 0"},
		{"duplicate", []Receipt{{ItemID: first}, {ItemID: first}, {ItemID: second}}, "不得重复"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := resolveReceipts(items, tc.receipts)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error = %v, want %q", err, tc.want)
			}
		})
	}
}

func assertVoucherEntryCount(t *testing.T, ctx context.Context, f transferFixture, id uuid.UUID, want int) {
	t.Helper()
	var got int
	if err := f.pool.QueryRow(ctx, `SELECT count(*) FROM inv_stock_entry
		WHERE voucher_type='inv.stock_transfer' AND voucher_id=$1`, id).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("voucher entries = %d, want %d", got, want)
	}
}

func assertBalance(t *testing.T, ctx context.Context, f transferFixture, warehouseID uuid.UUID, want decimal.Decimal) {
	t.Helper()
	var got decimal.Decimal
	if err := f.pool.QueryRow(ctx, `SELECT COALESCE(sum(quantity),0) FROM inv_stock_entry
		WHERE company_id=$1 AND warehouse_id=$2 AND material_id=$3 AND NOT is_cancelled`,
		f.companyID, warehouseID, f.materialID).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if !got.Equal(want) {
		t.Fatalf("balance warehouse %s = %s, want %s", warehouseID, got, want)
	}
}
