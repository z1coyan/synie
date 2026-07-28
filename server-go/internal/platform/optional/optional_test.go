package optional

import "testing"

func TestTriStateSemantics(t *testing.T) {
	unset := Unset[string]()
	if unset.Set || unset.Value != nil {
		t.Fatalf("unset = %#v", unset)
	}
	null := Null[string]()
	if !null.Set || null.Value != nil {
		t.Fatalf("null = %#v", null)
	}
	value := Of("x")
	if !value.Set || value.Value == nil || *value.Value != "x" {
		t.Fatalf("value = %#v", value)
	}
	// 显式置空字符串与置 null 必须可区分
	empty := Of("")
	if !empty.Set || empty.Value == nil || *empty.Value != "" {
		t.Fatalf("empty string = %#v", empty)
	}
}

func TestApply(t *testing.T) {
	existing := "old"
	target := &existing

	Apply(&target, Unset[string]())
	if target == nil || *target != "old" {
		t.Fatalf("unset must keep target, got %#v", target)
	}
	Apply(&target, Null[string]())
	if target != nil {
		t.Fatalf("null must clear target, got %#v", target)
	}
	Apply(&target, Of("new"))
	if target == nil || *target != "new" {
		t.Fatalf("value must overwrite target, got %#v", target)
	}
}

func TestMap(t *testing.T) {
	length := func(s string) int { return len(s) }
	if got := Map(Unset[string](), length); got.Set {
		t.Fatalf("unset mapped = %#v", got)
	}
	if got := Map(Null[string](), length); !got.Set || got.Value != nil {
		t.Fatalf("null mapped = %#v", got)
	}
	got := Map(Of("abc"), length)
	if !got.Set || got.Value == nil || *got.Value != 3 {
		t.Fatalf("value mapped = %#v", got)
	}
}
