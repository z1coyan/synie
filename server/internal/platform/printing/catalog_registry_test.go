package printing_test

import (
	"testing"

	"github.com/z1coyan/synie/server/internal/app/metaregistry"
	"github.com/z1coyan/synie/server/internal/platform/meta"
	"github.com/z1coyan/synie/server/internal/platform/printing"
)

// 打印字段目录由 meta.Registry 单一事实源派生。本测试守住真实 Registry
// 派生结果的关键结构（等价性已在快照删除前由逐字段对拍证明）。
func TestDerivedCatalogFromRealRegistry(t *testing.T) {
	registry := meta.NewRegistry()
	metaregistry.RegisterAll(registry)
	catalog := printing.NewFieldCatalog(registry)

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
		!containsField(items.Fields, "qty") || !containsField(items.Fields, "material.name") ||
		!containsField(items.Fields, "party_id") {
		t.Fatalf("sales.order items contract mismatch: %#v", items)
	}
	if containsField(items.Fields, "order_id") {
		t.Fatal("loop technical foreign key leaked")
	}

	quotation, ok := catalog.Get("sales.quotation")
	if !ok {
		t.Fatal("sales.quotation missing")
	}
	quotationItems, ok := loopByName(quotation.Loops, "items")
	if !ok || len(quotationItems.NestedLoops) != 1 || quotationItems.NestedLoops[0] != "tiers" {
		t.Fatalf("sales.quotation items nested loops = %#v", quotationItems.NestedLoops)
	}

	template, ok := catalog.Get("sys.print_template")
	if !ok || len(template.Loops) != 0 {
		t.Fatalf("sys.print_template = %#v, %v", template, ok)
	}
	if _, ok := catalog.Get("not.real"); ok {
		t.Fatal("unknown resource unexpectedly resolved")
	}

	// 派生是确定性的：同一 Registry 两次构建结果一致
	again := printing.NewFieldCatalog(registry)
	first, _ := catalog.Get("sales.order")
	second, _ := again.Get("sales.order")
	if len(first.Fields) != len(second.Fields) || len(first.Loops) != len(second.Loops) {
		t.Fatal("derived catalog is not deterministic")
	}
}

func contains(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

func containsField(values []printing.Field, want string) bool {
	for _, value := range values {
		if value.Name == want {
			return true
		}
	}
	return false
}

func loopByName(values []printing.Loop, want string) (printing.Loop, bool) {
	for _, value := range values {
		if value.Name == want {
			return value, true
		}
	}
	return printing.Loop{}, false
}
