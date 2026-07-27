package filterbuild_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
	"github.com/z1coyan/synie/server/internal/domain/base/market"
	"github.com/z1coyan/synie/server/internal/domain/base/unit"
	"github.com/z1coyan/synie/server/internal/testutil"
)

func TestPostgresUppercaseWireEnumsMatchLowercaseDatabaseValues(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool := testutil.NewPool(t, ctx)

	suffix := strings.ToUpper(strings.ReplaceAll(uuid.NewString(), "-", "")[:10])
	var currencyID, unitID, instrumentID uuid.UUID
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		if instrumentID != uuid.Nil {
			_, _ = pool.Exec(cleanupCtx, "DELETE FROM bas_market_instrument WHERE id=$1", instrumentID)
		}
		if unitID != uuid.Nil {
			_, _ = pool.Exec(cleanupCtx, "DELETE FROM bas_unit WHERE id=$1", unitID)
		}
		if currencyID != uuid.Nil {
			_, _ = pool.Exec(cleanupCtx, "DELETE FROM bas_currency WHERE id=$1", currencyID)
		}
	})
	if err := pool.QueryRow(ctx, `
		INSERT INTO bas_currency (name,iso_code,symbol) VALUES ($1,$2,$3) RETURNING id
	`, "筛选回归币种-"+suffix, "Z"+suffix[:2], "Z").Scan(&currencyID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO bas_unit (unit_type,is_base,name,symbol,ratio)
		VALUES ('weight',false,$1,$2,1) RETURNING id
	`, "筛选回归重量-"+suffix, "w-"+strings.ToLower(suffix)).Scan(&unitID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO bas_market_instrument
			(code,name,source_type,default_price_kind,currency_id,unit_id)
		VALUES ($1,$2,'exchange','settlement',$3,$4) RETURNING id
	`, "MKT-"+suffix, "筛选回归行情-"+suffix, currencyID, unitID).Scan(&instrumentID); err != nil {
		t.Fatal(err)
	}

	unitSQL, err := filterbuild.Build(unit.ResourceMeta(), filterbuild.Query{Filter: map[string]json.RawMessage{
		"unitType": json.RawMessage(`{"kind":"enum","values":["WEIGHT"]}`),
		"name":     json.RawMessage(`{"kind":"text","op":"contains","value":"` + suffix + `"}`),
	}})
	if err != nil {
		t.Fatal(err)
	}
	var unitCount int
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM bas_unit"+unitSQL.Where, unitSQL.Args...).Scan(&unitCount); err != nil {
		t.Fatal(err)
	}
	if unitCount != 1 {
		t.Fatalf("WEIGHT wire enum matched %d rows; sql=%s args=%#v", unitCount, unitSQL.Where, unitSQL.Args)
	}

	marketSQL, err := filterbuild.Build(market.InstrumentResourceMeta(), filterbuild.Query{Filter: map[string]json.RawMessage{
		"sourceType": json.RawMessage(`{"kind":"enum","values":["EXCHANGE"]}`),
		"code":       json.RawMessage(`{"kind":"text","op":"contains","value":"` + suffix + `"}`),
	}})
	if err != nil {
		t.Fatal(err)
	}
	var marketCount int
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM bas_market_instrument"+marketSQL.Where, marketSQL.Args...).Scan(&marketCount); err != nil {
		t.Fatal(err)
	}
	if marketCount != 1 {
		t.Fatalf("EXCHANGE wire enum matched %d rows; sql=%s args=%#v", marketCount, marketSQL.Where, marketSQL.Args)
	}
}
