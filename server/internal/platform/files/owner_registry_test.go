package files

import "testing"

func mustPanic(t *testing.T, fn func()) (panicked bool) {
	t.Helper()
	defer func() {
		panicked = recover() != nil
	}()
	fn()
	return false
}

func TestRegisterOwnerPanicsOnDuplicate(t *testing.T) {
	spec := OwnerSpec{Table: "test_table", PermissionPrefix: "test.owner"}
	RegisterOwner("test_duplicate_owner", spec)
	if !mustPanic(t, func() { RegisterOwner("test_duplicate_owner", spec) }) {
		t.Fatal("重复注册同一 ownerType 未 panic")
	}
}

func TestRegisterOwnerPanicsOnRegisteredDomainOwner(t *testing.T) {
	// owner_assembly_test.go 的 init 已注册全部领域宿主；重复注册必须 fail-fast。
	spec := OwnerSpec{Table: "test_table", PermissionPrefix: "test.owner"}
	if !mustPanic(t, func() { RegisterOwner("sal_customer", spec) }) {
		t.Fatal("重复注册已装配的领域宿主未 panic")
	}
}

func TestRegisterOwnerPanicsOnIncompleteSpec(t *testing.T) {
	cases := map[string]OwnerSpec{
		"test_incomplete_table":  {PermissionPrefix: "test.owner"},
		"test_incomplete_prefix": {Table: "test_table"},
	}
	for ownerType, spec := range cases {
		if !mustPanic(t, func() { RegisterOwner(ownerType, spec) }) {
			t.Fatalf("不完整 spec 注册 %s 未 panic", ownerType)
		}
	}
	if !mustPanic(t, func() {
		RegisterOwner("", OwnerSpec{Table: "test_table", PermissionPrefix: "test.owner"})
	}) {
		t.Fatal("空 ownerType 注册未 panic")
	}
}
