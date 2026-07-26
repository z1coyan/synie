package glentry

import "testing"

func TestResourceMetaContract(t *testing.T) {
	resource := ResourceMeta()
	if resource.Name != "accGlEntries" || resource.PermissionPrefix != "acc.gl_entry" {
		t.Fatalf("resource identity = %#v", resource)
	}
	want := []string{
		"id", "seq", "postingDate", "debit", "credit", "partyType", "partyId",
		"voucherType", "voucherId", "voucherNo", "isCancelled", "isReversed",
		"isReversal", "remarks", "insertedAt", "companyId", "accountId", "currencyId",
	}
	if len(resource.Fields) != len(want) {
		t.Fatalf("field count = %d", len(resource.Fields))
	}
	for index, field := range resource.Fields {
		if field.APIName != want[index] {
			t.Fatalf("field %d = %q, want %q", index, field.APIName, want[index])
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
	partyRef, voucherRef := resource.Fields[6].Ref, resource.Fields[8].Ref
	if partyRef == nil || len(partyRef.Variants) != 4 {
		t.Fatalf("party ref = %#v", partyRef)
	}
	if voucherRef == nil || len(voucherRef.Variants) != 9 {
		t.Fatalf("voucher ref = %#v", voucherRef)
	}
}
