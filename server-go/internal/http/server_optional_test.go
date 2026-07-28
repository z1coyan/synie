package httpapi

import (
	"net/http/httptest"
	"strings"
	"testing"
)

// TestDecodePatchJSONNullVsOmitted 锁定 PATCH 三态语义的 HTTP 入口行为:
// 键缺席 = 未设置, 显式 null = 置 null, 有值 = 设置值。
func TestDecodePatchJSONNullVsOmitted(t *testing.T) {
	type body struct {
		Remarks *string `json:"remarks,omitempty"`
	}
	cases := []struct {
		name     string
		raw      string
		wantSet  bool
		wantNull bool
		wantVal  string
	}{
		{"omitted", `{}`, false, false, ""},
		{"explicit null", `{"remarks":null}`, true, true, ""},
		{"value", `{"remarks":"hi"}`, true, false, "hi"},
		{"empty string", `{"remarks":""}`, true, false, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			request := httptest.NewRequest("PATCH", "/x", strings.NewReader(tc.raw))
			recorder := httptest.NewRecorder()
			var parsed body
			fields, err := decodePatchJSON(recorder, request, &parsed)
			if err != nil {
				t.Fatalf("decode = %v", err)
			}
			got := optionalField(fields, "remarks", parsed.Remarks)
			if got.Set != tc.wantSet {
				t.Fatalf("Set = %v, want %v", got.Set, tc.wantSet)
			}
			if got.Set && (got.Value == nil) != tc.wantNull {
				t.Fatalf("Value = %#v, wantNull=%v", got.Value, tc.wantNull)
			}
			if got.Value != nil && *got.Value != tc.wantVal {
				t.Fatalf("Value = %q, want %q", *got.Value, tc.wantVal)
			}
		})
	}
}

// TestDecodePatchJSONRejectsUnknownField 保持 DisallowUnknownFields 的既有严格性。
func TestDecodePatchJSONRejectsUnknownField(t *testing.T) {
	type body struct {
		Remarks *string `json:"remarks,omitempty"`
	}
	request := httptest.NewRequest("PATCH", "/x", strings.NewReader(`{"unknown":1}`))
	recorder := httptest.NewRecorder()
	var parsed body
	if _, err := decodePatchJSON(recorder, request, &parsed); err == nil {
		t.Fatal("unknown field must be rejected")
	}
}

// TestOptionalUpdateStringTriState 锁定单字段 json.RawMessage 解码的三态映射。
func TestOptionalUpdateStringTriState(t *testing.T) {
	got, err := optionalUpdate[string](nil)
	if err != nil || got.Set {
		t.Fatalf("omitted = %#v, err=%v", got, err)
	}
	got, err = optionalUpdate[string]([]byte(`null`))
	if err != nil || !got.Set || got.Value != nil {
		t.Fatalf("null = %#v, err=%v", got, err)
	}
	got, err = optionalUpdate[string]([]byte(`"v"`))
	if err != nil || !got.Set || got.Value == nil || *got.Value != "v" {
		t.Fatalf("value = %#v, err=%v", got, err)
	}
	if _, err = optionalUpdate[string]([]byte(`123`)); err == nil {
		t.Fatal("non-string must fail")
	}
}
