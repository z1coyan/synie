package printing

import (
	"errors"
	"reflect"
	"testing"

	"github.com/z1coyan/synie/server/internal/platform/apierror"
)

func TestFieldCatalogPreservesCapturedLegacyContract(t *testing.T) {
	catalog := NewFieldCatalog()
	resources := catalog.Resources()
	if len(resources) != 60 {
		t.Fatalf("resources = %d, want 60", len(resources))
	}
	if !contains(resources, "sales.order") || !contains(resources, "sys.print_template") {
		t.Fatalf("missing required resources: %#v", resources)
	}

	order, ok := catalog.Get("sales.order")
	if !ok {
		t.Fatal("sales.order missing")
	}
	for _, name := range []string{
		"order_no", "status", "gross_total", "company.name", "company.code", "party.name",
	} {
		if !containsField(order.Fields, name) {
			t.Errorf("sales.order field %q missing", name)
		}
	}
	if containsField(order.Fields, "id") || containsField(order.Fields, "company_id") ||
		containsField(order.Fields, "party_id") || containsField(order.Fields, "inserted_at") {
		t.Fatalf("technical field leaked into sales.order: %#v", order.Fields)
	}
	items, ok := loopByName(order.Loops, "items")
	if !ok || !containsField(items.Fields, "material_name") ||
		!containsField(items.Fields, "qty") || !containsField(items.Fields, "material.name") {
		t.Fatalf("sales.order items contract mismatch: %#v", items)
	}
	if containsField(items.Fields, "order_id") {
		t.Fatal("loop technical foreign key leaked")
	}

	template, ok := catalog.Get("sys.print_template")
	if !ok || len(template.Loops) != 0 {
		t.Fatalf("sys.print_template = %#v, %v", template, ok)
	}
	if _, ok := catalog.Get("not.real"); ok {
		t.Fatal("unknown resource unexpectedly resolved")
	}
}

func TestValidatePlaceholdersMatchesLegacyClassification(t *testing.T) {
	catalog := NewFieldCatalog()
	valid := PlaceholderSet{
		Fields: []string{"order_no", "party.name"},
		Nested: map[string][]string{
			"company": {"name"},
			"items":   {"_seq", "qty", "material.name"},
		},
	}
	if err := catalog.ValidatePlaceholders("sales.order", valid); err != nil {
		t.Fatalf("valid placeholders: %v", err)
	}

	err := catalog.ValidatePlaceholders("sales.quotation", PlaceholderSet{
		Fields: []string{"id", "old_flat_key"},
		Nested: map[string][]string{
			"company": {"address.city", "unknown"},
			"items":   {"tiers.qty", "unknown"},
		},
	})
	if codeOf(err) != apierror.CodeValidation {
		t.Fatalf("error = %#v", err)
	}
	want := "未知头字段: company.unknown, id, old_flat_key；未知循环区字段: items.unknown；关联路径只支持一层: company.address.city；不支持嵌套循环: items.tiers"
	if err.Error() != want {
		t.Fatalf("error = %q, want %q", err, want)
	}

	err = catalog.ValidatePlaceholders("not.real", PlaceholderSet{})
	if err == nil || err.Error() != "不支持的资源类型 not.real" {
		t.Fatalf("unknown resource error = %#v", err)
	}
}

func TestFieldCatalogReturnsCopies(t *testing.T) {
	catalog := NewFieldCatalog()
	first, _ := catalog.Get("sales.order")
	first.Fields[0].Name = "mutated"
	first.Loops[0].Fields[0].Name = "mutated"
	second, _ := catalog.Get("sales.order")
	if second.Fields[0].Name == "mutated" || second.Loops[0].Fields[0].Name == "mutated" {
		t.Fatal("catalog leaked mutable internal slices")
	}
	if !reflect.DeepEqual(catalog.Resources(), catalog.Resources()) {
		t.Fatal("resource ordering is unstable")
	}
}

func codeOf(err error) apierror.Code {
	var appErr *apierror.Error
	if errors.As(err, &appErr) {
		return appErr.Code
	}
	return ""
}

func contains(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

func containsField(values []Field, want string) bool {
	for _, value := range values {
		if value.Name == want {
			return true
		}
	}
	return false
}

func loopByName(values []Loop, want string) (Loop, bool) {
	for _, value := range values {
		if value.Name == want {
			return value, true
		}
	}
	return Loop{}, false
}
