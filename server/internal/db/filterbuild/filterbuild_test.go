package filterbuild

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/meta"
)

func testResource() meta.ResourceMeta {
	discriminator := "partyType"
	return meta.ResourceMeta{
		Name:             "fixture",
		PermissionPrefix: "fixture.row",
		PermissionLabel:  "夹具",
		Table:            "fixture_row",
		Fields: []meta.FieldMeta{
			{APIName: "name", DBColumn: "name", Type: meta.TypeString, Filterable: true, Sortable: true},
			{APIName: "active", DBColumn: "active", Type: meta.TypeBoolean, Filterable: true},
			{APIName: "status", DBColumn: "status", Type: meta.TypeEnum, Filterable: true, EnumOptions: []meta.EnumOption{{Value: "DRAFT"}, {Value: "AUDITED"}}},
			{APIName: "tags", DBColumn: "tags", Type: meta.TypeEnumArray, Filterable: true, EnumOptions: []meta.EnumOption{{Value: "A"}, {Value: "B"}}},
			{APIName: "amount", DBColumn: "amount", Type: meta.TypeDecimal, Filterable: true, Sortable: true},
			{APIName: "postedOn", DBColumn: "posted_on", Type: meta.TypeDate, Filterable: true},
			{APIName: "insertedAt", DBColumn: "inserted_at", Type: meta.TypeDatetime, Filterable: true},
			{APIName: "companyId", DBColumn: "company_id", Type: meta.TypeFK, Filterable: true},
			{APIName: "partyType", DBColumn: "party_type", Type: meta.TypeEnum, Filterable: true, EnumOptions: []meta.EnumOption{{Value: "CUSTOMER"}}},
			{
				APIName: "partyId", DBColumn: "party_id", Type: meta.TypeFK, Filterable: true,
				Ref: &meta.GridColumnRef{
					Discriminator: &discriminator,
					Variants:      []meta.GridColumnRefVariant{{Value: "CUSTOMER", Resource: "customers"}},
				},
			},
			{APIName: "opaque", DBColumn: "opaque", Type: meta.TypeString, Filterable: false},
		},
	}
}

func raw(value string) json.RawMessage {
	return json.RawMessage(value)
}

func TestBuildCoversFilterStateKinds(t *testing.T) {
	id := "11111111-1111-4111-8111-111111111111"
	query := Query{
		Search: "100%_safe",
		Sort:   &Sort{Column: "amount", Direction: "descending"},
		Filter: map[string]json.RawMessage{
			"name":       raw(`{"kind":"text","op":"contains","value":"铜%管"}`),
			"active":     raw(`{"kind":"bool","eq":true}`),
			"status":     raw(`{"kind":"enum","values":["AUDITED"]}`),
			"tags":       raw(`{"kind":"enumArray","op":"notHas","values":["A"]}`),
			"amount":     raw(`{"kind":"number","op":"between","gte":"1.005","lte":"9.99"}`),
			"postedOn":   raw(`{"kind":"date","op":"after","value":"2026-07-25"}`),
			"insertedAt": raw(`{"kind":"date","op":"eq","value":"2026-07-25"}`),
			"companyId":  raw(`{"kind":"fk","values":["` + id + `"],"labels":["甲公司"]}`),
			"partyId":    raw(`{"kind":"polyFk","op":"in","variant":"CUSTOMER","values":["` + id + `"],"labels":["客户甲"]}`),
		},
	}
	got, err := Build(testResource(), query)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`"name" ILIKE`,
		`"active" =`,
		`"status" = ANY`,
		`NOT ("tags" &&`,
		`"amount" >=`,
		`"amount" <=`,
		`"posted_on" >`,
		`"inserted_at" >=`,
		`"company_id"::text = ANY`,
		`"party_type" =`,
		`"party_id"::text = ANY`,
		`ORDER BY "amount" DESC`,
	} {
		if !strings.Contains(got.Where+got.OrderBy, want) {
			t.Errorf("SQL 缺少 %q:\n%s%s", want, got.Where, got.OrderBy)
		}
	}
	if len(got.Args) != 12 {
		t.Fatalf("args = %#v", got.Args)
	}
	if !containsStringSlice(got.Args, []string{"audited"}) {
		t.Fatalf("enum args must bind lowercase DB values: %#v", got.Args)
	}
	if !containsStringSlice(got.Args, []string{"a"}) {
		t.Fatalf("enumArray args must bind lowercase DB values: %#v", got.Args)
	}
	if !containsStringArg(got.Args, "customer") {
		t.Fatalf("poly discriminator must bind lowercase DB value: %#v", got.Args)
	}
}

func containsStringSlice(args []any, expected []string) bool {
	for _, arg := range args {
		values, ok := arg.([]string)
		if !ok || len(values) != len(expected) {
			continue
		}
		equal := true
		for i := range values {
			if values[i] != expected[i] {
				equal = false
			}
		}
		if equal {
			return true
		}
	}
	return false
}

func containsStringArg(args []any, expected string) bool {
	for _, arg := range args {
		if value, ok := arg.(string); ok && value == expected {
			return true
		}
	}
	return false
}

func TestBuildRejectsUnknownAndMismatchedFields(t *testing.T) {
	tests := []Query{
		{Filter: map[string]json.RawMessage{"missing": raw(`{"kind":"text","op":"eq","value":"x"}`)}},
		{Filter: map[string]json.RawMessage{"opaque": raw(`{"kind":"text","op":"eq","value":"x"}`)}},
		{Filter: map[string]json.RawMessage{"active": raw(`{"kind":"text","op":"eq","value":"x"}`)}},
		{Filter: map[string]json.RawMessage{"status": raw(`{"kind":"enum","values":["HACKED"]}`)}},
		{Sort: &Sort{Column: "opaque", Direction: "ascending"}},
	}
	for i, query := range tests {
		if _, err := Build(testResource(), query); apierror.Status(err) != 400 {
			t.Errorf("case %d: want validation, got %v", i, err)
		}
	}
}

func TestBuildRejectsDecimalNumberSyntax(t *testing.T) {
	for _, bad := range []string{"1e3", "0x10", " 10 ", "NaN"} {
		_, err := Build(testResource(), Query{Filter: map[string]json.RawMessage{
			"amount": raw(`{"kind":"number","op":"eq","value":"` + bad + `"}`),
		}})
		if apierror.Status(err) != 400 {
			t.Errorf("%q should fail, got %v", bad, err)
		}
	}
}
