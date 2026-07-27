package stockdoc

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/platform/numbering"
	"github.com/z1coyan/synie/server/internal/testutil"
)

type fixedTxNumberer struct {
	number string
	called bool
}

func (n *fixedTxNumberer) NextInTx(
	ctx context.Context,
	tx pgx.Tx,
	_ numbering.NextInput,
) (string, error) {
	n.called = true
	var one int
	if err := tx.QueryRow(ctx, "SELECT 1").Scan(&one); err != nil {
		return "", err
	}
	return n.number, nil
}

type docFixture struct {
	pool        *pgxpool.Pool
	companyID   uuid.UUID
	userID      uuid.UUID
	unitID      uuid.UUID
	boxID       uuid.UUID
	categoryID  uuid.UUID
	materialID  uuid.UUID
	warehouseID uuid.UUID
}

func TestPostgresStockDocAggregateLifecycle(t *testing.T) {
	fixture := newDocFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	actor := &authz.Actor{
		UserID: fixture.userID, Username: "stockdoc-pg-test",
		SuperAdmin: true, CompanyIDs: []uuid.UUID{fixture.companyID},
	}
	numberer := &fixedTxNumberer{number: "AUTO-" + strings.ReplaceAll(uuid.NewString(), "-", "")[:20]}
	service := NewService(fixture.pool, numberer)
	summary := "期初入库"
	doc, err := service.Create(ctx, actor, CreateInput{
		Direction: DirectionIn, CompanyID: fixture.companyID,
		WarehouseID: fixture.warehouseID, Summary: &summary,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !numberer.called || doc.DocNo != numberer.number || doc.Status != StatusDraft ||
		doc.CreatedByID == nil || *doc.CreatedByID != fixture.userID {
		t.Fatalf("created doc = %#v, numberer called=%v", doc, numberer.called)
	}

	item, err := service.CreateItem(ctx, actor, CreateItemInput{
		StockDocID: doc.ID, Idx: 1, Qty: decimal.NewFromInt(5),
		MaterialID: fixture.materialID, UnitID: fixture.boxID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !item.BaseQty.Equal(decimal.RequireFromString("0.5")) ||
		item.MaterialName == "" || item.UnitName == "" ||
		item.CompanyID != fixture.companyID {
		t.Fatalf("created item = %#v", item)
	}

	audited, err := service.Audit(ctx, actor, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	if audited.Status != StatusAudited || audited.AuditedAt == nil ||
		audited.AuditedByID == nil || *audited.AuditedByID != fixture.userID {
		t.Fatalf("audited doc = %#v", audited)
	}
	var quantity decimal.Decimal
	var cancelled bool
	if err := fixture.pool.QueryRow(ctx, `
		SELECT quantity,is_cancelled
		FROM inv_stock_entry
		WHERE voucher_type='inv.stock_doc' AND voucher_id=$1
	`, doc.ID).Scan(&quantity, &cancelled); err != nil {
		t.Fatal(err)
	}
	if !quantity.Equal(decimal.RequireFromString("0.5")) || cancelled {
		t.Fatalf("entry quantity=%s cancelled=%v", quantity, cancelled)
	}
	newQty := decimal.NewFromInt(10)
	if _, err := service.UpdateItem(ctx, actor, item.ID, UpdateItemInput{Qty: &newQty}); err == nil {
		t.Fatal("audited item update must fail")
	}

	voided, err := service.Void(ctx, actor, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	if voided.Status != StatusVoided {
		t.Fatalf("voided doc = %#v", voided)
	}
	if err := fixture.pool.QueryRow(ctx, `
		SELECT is_cancelled FROM inv_stock_entry
		WHERE voucher_type='inv.stock_doc' AND voucher_id=$1
	`, doc.ID).Scan(&cancelled); err != nil {
		t.Fatal(err)
	}
	if !cancelled {
		t.Fatal("void must cancel the stock fact")
	}
	if err := service.Delete(ctx, actor, doc.ID); err == nil {
		t.Fatal("voided doc delete must fail")
	}

	var actions []string
	rows, err := fixture.pool.Query(ctx, `
		SELECT action_name FROM sys_audit_log
		WHERE resource='inv_stock_doc' AND record_id=$1
		ORDER BY inserted_at,id
	`, doc.ID)
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
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if strings.Join(actions, ",") != "create,audit,void" {
		t.Fatalf("head audit actions = %#v", actions)
	}
}

func newDocFixture(t *testing.T) docFixture {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pool := testutil.NewPool(t, ctx)
	suffix := strings.ReplaceAll(uuid.NewString(), "-", "")[:12]
	fixture := docFixture{
		pool: pool, companyID: uuid.New(), userID: uuid.New(),
		unitID: uuid.New(), boxID: uuid.New(), categoryID: uuid.New(),
		materialID: uuid.New(), warehouseID: uuid.New(),
	}
	currencyID := uuid.New()
	if err := seedDocFixture(ctx, pool, fixture, currencyID, suffix); err != nil {
		pool.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM sys_audit_log WHERE company_id=$1", fixture.companyID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM inv_stock_entry WHERE company_id=$1", fixture.companyID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM inv_stock_doc_item WHERE company_id=$1", fixture.companyID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM inv_stock_doc WHERE company_id=$1", fixture.companyID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM inv_material_unit WHERE material_id=$1", fixture.materialID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM inv_warehouse WHERE company_id=$1", fixture.companyID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM inv_material WHERE id=$1", fixture.materialID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM inv_material_category WHERE id=$1", fixture.categoryID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM sys_user WHERE id=$1", fixture.userID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM bas_company WHERE id=$1", fixture.companyID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM bas_unit WHERE id=ANY($1::uuid[])", []uuid.UUID{fixture.unitID, fixture.boxID})
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM bas_currency WHERE id=$1", currencyID)
		pool.Close()
	})
	return fixture
}
