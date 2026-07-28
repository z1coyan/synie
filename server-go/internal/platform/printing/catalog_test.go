package printing

import (
	"errors"
	"reflect"
	"testing"

	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/meta"
)

// newTestCatalog 用合成 Registry 构造测试目录：覆盖头字段标量/关联展开/多态、
// 循环区与嵌套循环派生，不依赖任何领域包（避免平台层反向依赖）。
func newTestCatalog() *FieldCatalog {
	company, material := "basCompanies", "invMaterials"
	companyRel, materialRel := "company", "material"
	name := "name"
	discriminator, discriminatorType := "partyType", "enum"
	partyVariants := []meta.GridColumnRefVariant{
		{Value: "COMPANY", Resource: "basCompanies", LabelField: "name", Label: "内部公司"},
		{Value: "CUSTOMER", Resource: "salCustomers", LabelField: "name", Label: "客户"},
	}
	scalar := func(name string) meta.FieldMeta {
		return meta.FieldMeta{Name: name, APIName: name, DBColumn: name, Type: meta.TypeString, Label: name}
	}
	registry := meta.NewRegistry()
	registry.MustRegister(meta.ResourceMeta{
		Name: "basCompanies", PermissionPrefix: "base.company", PermissionLabel: "公司", Table: "bas_company",
		Fields: []meta.FieldMeta{
			scalar("id"), scalar("code"), scalar("name"), scalar("short_name"),
			scalar("inserted_at"), scalar("updated_at"),
		},
		Actions: []meta.ActionMeta{{Key: "read", Label: "查看", Scope: "both"}},
	})
	registry.MustRegister(meta.ResourceMeta{
		Name: "invMaterials", PermissionPrefix: "inv.material", PermissionLabel: "物料", Table: "inv_material",
		Fields:  []meta.FieldMeta{scalar("id"), scalar("code"), scalar("name")},
		Actions: []meta.ActionMeta{{Key: "read", Label: "查看", Scope: "both"}},
	})
	registry.MustRegister(meta.ResourceMeta{
		Name: "salOrders", PermissionPrefix: "sales.order", PermissionLabel: "销售订单", Table: "sal_order",
		Fields: []meta.FieldMeta{
			scalar("id"), scalar("order_no"), scalar("status"), scalar("inserted_at"), scalar("updated_at"),
			{Name: "gross_total", APIName: "grossTotal", DBColumn: "gross_total", Type: meta.TypeDecimal, Label: "总额", Calculated: true},
			{Name: "api_secret", APIName: "apiSecret", DBColumn: "api_secret", Type: meta.TypeString, Label: "密钥", Sensitive: true},
			{Name: "company_id", APIName: "companyId", DBColumn: "company_id", Type: meta.TypeFK, Label: "公司",
				Ref: &meta.GridColumnRef{Resource: &company, Relation: &companyRel, LabelField: &name}},
			{Name: "party_id", APIName: "partyId", DBColumn: "party_id", Type: meta.TypeFK, Label: "对手",
				Ref: &meta.GridColumnRef{Discriminator: &discriminator, DiscriminatorType: &discriminatorType, Variants: partyVariants}},
		},
		PrintHead:  true,
		PrintLoops: []meta.PrintLoopMeta{{Name: "items", Resource: "salOrderItems"}},
		Actions:    []meta.ActionMeta{{Key: "read", Label: "查看", Scope: "both"}},
	})
	registry.MustRegister(meta.ResourceMeta{
		Name: "salOrderItems", PermissionPrefix: "sales.order", PermissionLabel: "销售订单", Table: "sal_order_item",
		Fields: []meta.FieldMeta{
			scalar("id"), scalar("qty"), scalar("amount"), scalar("material_name"), scalar("unit_name"),
			{Name: "material_id", APIName: "materialId", DBColumn: "material_id", Type: meta.TypeFK, Label: "物料",
				Ref: &meta.GridColumnRef{Resource: &material, Relation: &materialRel, LabelField: &name}},
			{Name: "party_id", APIName: "partyId", DBColumn: "party_id", Type: meta.TypeFK, Label: "对手",
				PrintRawID: true,
				Ref:        &meta.GridColumnRef{Discriminator: &discriminator, DiscriminatorType: &discriminatorType, Variants: partyVariants}},
		},
		Actions: []meta.ActionMeta{{Key: "read", Label: "查看", Scope: "both"}},
	})
	registry.MustRegister(meta.ResourceMeta{
		Name: "salQuotations", PermissionPrefix: "sales.quotation", PermissionLabel: "销售报价", Table: "sal_quotation",
		Fields: []meta.FieldMeta{
			scalar("id"), scalar("quotation_no"),
			{Name: "company_id", APIName: "companyId", DBColumn: "company_id", Type: meta.TypeFK, Label: "公司",
				Ref: &meta.GridColumnRef{Resource: &company, Relation: &companyRel, LabelField: &name}},
		},
		PrintHead:  true,
		PrintLoops: []meta.PrintLoopMeta{{Name: "items", Resource: "salQuotationItems"}},
		Actions:    []meta.ActionMeta{{Key: "read", Label: "查看", Scope: "both"}},
	})
	registry.MustRegister(meta.ResourceMeta{
		Name: "salQuotationItems", PermissionPrefix: "sales.quotation", PermissionLabel: "销售报价", Table: "sal_quotation_item",
		Fields:     []meta.FieldMeta{scalar("id"), scalar("qty")},
		PrintLoops: []meta.PrintLoopMeta{{Name: "tiers", Resource: "salQuotationTiers"}},
		Actions:    []meta.ActionMeta{{Key: "read", Label: "查看", Scope: "both"}},
	})
	registry.MustRegister(meta.ResourceMeta{
		Name: "salQuotationTiers", PermissionPrefix: "sales.quotation", PermissionLabel: "销售报价", Table: "sal_quotation_tier",
		Fields:  []meta.FieldMeta{scalar("id"), scalar("price")},
		Actions: []meta.ActionMeta{{Key: "read", Label: "查看", Scope: "both"}},
	})
	// 只读投影视图不进入打印目录
	registry.MustRegister(meta.ResourceMeta{
		Name: "xProjection", PermissionPrefix: "x.projection", PermissionLabel: "投影", Table: "x_projection",
		ReadPermissionsAny: []string{"sales.order:read"},
		Fields:             []meta.FieldMeta{scalar("id"), scalar("note")},
		Actions:            []meta.ActionMeta{{Key: "read", Label: "查看", Scope: "both"}},
	})
	return NewFieldCatalog(registry)
}

func TestFieldCatalogDerivesFieldsFromMetaRegistry(t *testing.T) {
	catalog := newTestCatalog()
	resources := catalog.Resources()
	if !contains(resources, "sales.order") || !contains(resources, "base.company") {
		t.Fatalf("missing derived resources: %#v", resources)
	}
	if contains(resources, "x.projection") {
		t.Fatal("只读投影视图进入打印目录")
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
	for _, excluded := range []string{"id", "inserted_at", "company_id", "party_id", "api_secret"} {
		if containsField(order.Fields, excluded) {
			t.Errorf("technical/sensitive field %q leaked into sales.order", excluded)
		}
	}
	items, ok := loopByName(order.Loops, "items")
	if !ok {
		t.Fatalf("sales.order items loop missing: %#v", order.Loops)
	}
	for _, name := range []string{"qty", "material_name", "material.name", "party_id"} {
		if !containsField(items.Fields, name) {
			t.Errorf("sales.order items field %q missing", name)
		}
	}
	if containsField(items.Fields, "party.name") {
		t.Error("PrintRawID 子表不应展开 party.name")
	}
	if len(items.NestedLoops) != 0 {
		t.Errorf("unexpected nested loops: %#v", items.NestedLoops)
	}

	quotation, ok := catalog.Get("sales.quotation")
	if !ok {
		t.Fatal("sales.quotation missing")
	}
	qItems, ok := loopByName(quotation.Loops, "items")
	if !ok || !reflect.DeepEqual(qItems.NestedLoops, []string{"tiers"}) {
		t.Fatalf("sales.quotation items nested loops = %#v", qItems.NestedLoops)
	}

	if _, ok := catalog.Get("not.real"); ok {
		t.Fatal("unknown resource unexpectedly resolved")
	}
}

func TestValidatePlaceholdersMatchesLegacyClassification(t *testing.T) {
	catalog := newTestCatalog()
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
	catalog := newTestCatalog()
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

func TestFieldCatalogRejectsAmbiguousPrintHead(t *testing.T) {
	scalar := meta.FieldMeta{Name: "id", APIName: "id", DBColumn: "id", Type: meta.TypeUUID, Label: "id"}
	registry := meta.NewRegistry()
	for _, name := range []string{"xHeads", "xItems"} {
		registry.MustRegister(meta.ResourceMeta{
			Name: name, PermissionPrefix: "x.ambiguous", PermissionLabel: "歧义", Table: "x_ambiguous",
			Fields:  []meta.FieldMeta{scalar},
			Actions: []meta.ActionMeta{{Key: "read", Label: "查看", Scope: "both"}},
		})
	}
	defer func() {
		if recover() == nil {
			t.Fatal("前缀多候选且未标记 PrintHead 时应 panic")
		}
	}()
	NewFieldCatalog(registry)
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
