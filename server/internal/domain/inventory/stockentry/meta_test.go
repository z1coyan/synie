package stockentry

import "testing"

func TestResourceMetaContract(t *testing.T) {
	resource := ResourceMeta()
	if resource.Name != "invStockEntries" || resource.PermissionPrefix != "inv.stock_entry" {
		t.Fatalf("resource identity = %#v", resource)
	}
	want := []string{
		"id", "seq", "quantity", "postingDate", "voucherType", "voucherId",
		"voucherNo", "isCancelled", "cancelledAt", "remarks", "insertedAt",
		"companyId", "warehouseId", "materialId",
	}
	if len(resource.Fields) != len(want) {
		t.Fatalf("field count = %d", len(resource.Fields))
	}
	for i, field := range resource.Fields {
		if field.APIName != want[i] {
			t.Fatalf("field %d = %q, want %q", i, field.APIName, want[i])
		}
		if !field.Readonly {
			t.Fatalf("field %q must be readonly", field.APIName)
		}
	}
	if len(resource.Actions) != 1 || resource.Actions[0].Key != "read" {
		t.Fatalf("actions = %#v", resource.Actions)
	}
	if resource.DestroyMutation != nil || resource.Audit.Enabled {
		t.Fatalf("write surface leaked: destroy=%v audit=%v", resource.DestroyMutation, resource.Audit)
	}
	ref := resource.Fields[5].Ref
	if ref == nil || ref.Discriminator == nil || *ref.Discriminator != "voucherType" ||
		len(ref.Variants) != 8 {
		t.Fatalf("voucher ref = %#v", ref)
	}
}
