package filterbuild

import (
	"encoding/json"
	"testing"
)

func TestBuildSupportsNilOrdinaryForeignKey(t *testing.T) {
	got, err := Build(testResource(), Query{Filter: map[string]json.RawMessage{
		"companyId": raw(`{"kind":"fk","op":"isNil"}`),
	}})
	if err != nil {
		t.Fatal(err)
	}
	if got.Where != ` WHERE "company_id" IS NULL` {
		t.Fatalf("where = %q", got.Where)
	}
	if len(got.Args) != 0 {
		t.Fatalf("args = %#v", got.Args)
	}
}
