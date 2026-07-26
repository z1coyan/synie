package market

import (
	"testing"

	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/platform/meta"
)

func TestMarketMetaPermissionAndActionContracts(t *testing.T) {
	registry := meta.NewRegistry()
	for _, resource := range ResourceMetas() {
		registry.MustRegister(resource)
	}
	instrumentActor := &authz.Actor{Permissions: map[string]struct{}{
		"base.market_instrument:read": {}, "base.market_instrument:update": {},
	}}
	document, err := registry.BuildDocument(InstrumentResourceName, instrumentActor)
	if err != nil {
		t.Fatal(err)
	}
	if len(document.Grid.Capabilities) != 1 || document.Grid.Capabilities[0] != "update" {
		t.Fatalf("instrument capabilities = %#v", document.Grid.Capabilities)
	}
	priceActor := &authz.Actor{Permissions: map[string]struct{}{
		"base.market_price:read": {}, "base.market_price:void": {},
	}}
	document, err = registry.BuildDocument(PricePointResourceName, priceActor)
	if err != nil {
		t.Fatal(err)
	}
	if len(document.Grid.Capabilities) != 1 || document.Grid.Capabilities[0] != "void" {
		t.Fatalf("price capabilities = %#v", document.Grid.Capabilities)
	}
	if len(document.Grid.ExtendedActions) != 1 ||
		document.Grid.ExtendedActions[0].Key != "void" ||
		document.Grid.ExtendedActions[0].Mutation != "voidBasMarketPricePoint" {
		t.Fatalf("price actions = %#v", document.Grid.ExtendedActions)
	}
}

func TestMarketValidationContracts(t *testing.T) {
	if _, _, _, _, err := normalizeInstrument("CU", "沪铜", "EXCHANGE", "SETTLEMENT"); err != nil {
		t.Fatal(err)
	}
	if _, _, _, _, err := normalizeInstrument("", "", "bad", "bad"); err == nil {
		t.Fatal("invalid instrument accepted")
	}
}
