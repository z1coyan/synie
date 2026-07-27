package unit

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/testutil"
)

func TestPostgresReferencedUnitCannotBeDeleted(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool := testutil.NewPool(t, ctx)

	suffix := strings.ToLower(strings.ReplaceAll(uuid.NewString(), "-", "")[:10])
	service := NewService(pool)
	actor := &authz.Actor{UserID: uuid.New(), Username: "unit-reference-test", SuperAdmin: true}
	item, err := service.Create(ctx, actor, CreateInput{
		UnitType: "WEIGHT", Name: "引用删除测试-" + suffix, Symbol: "r" + suffix, Ratio: "1",
	})
	if err != nil {
		t.Fatal(err)
	}
	var currencyID, instrumentID uuid.UUID
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		if instrumentID != uuid.Nil {
			_, _ = pool.Exec(cleanupCtx, "DELETE FROM bas_market_instrument WHERE id = $1", instrumentID)
		}
		if currencyID != uuid.Nil {
			_, _ = pool.Exec(cleanupCtx, "DELETE FROM bas_currency WHERE id = $1", currencyID)
		}
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM sys_audit_log WHERE resource = 'bas_unit' AND record_id = $1", item.ID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM bas_unit WHERE id = $1", item.ID)
	})

	if err := pool.QueryRow(ctx, `
		INSERT INTO bas_currency (name, iso_code, symbol)
		VALUES ($1, $2, $3)
		RETURNING id
	`, "引用删除测试币-"+suffix, strings.ToUpper(suffix[:3]), "R").Scan(&currencyID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO bas_market_instrument (
			code, name, source_type, default_price_kind, currency_id, unit_id
		) VALUES ($1, $2, 'other', 'last', $3, $4)
		RETURNING id
	`, "REF-"+suffix, "引用删除测试行情-"+suffix, currencyID, item.ID).Scan(&instrumentID); err != nil {
		t.Fatal(err)
	}

	if err := service.Delete(ctx, actor, item.ID); errorCode(err) != apierror.CodeConflict {
		t.Fatalf("delete referenced unit error = %#v", err)
	}
	if _, err := service.Get(ctx, item.ID); err != nil {
		t.Fatalf("referenced unit must remain after failed delete: %v", err)
	}
}
