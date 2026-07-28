package apierror

import (
	"errors"
	"net/http"
	"testing"
)

func TestStatus(t *testing.T) {
	t.Parallel()
	tests := []struct {
		code Code
		want int
	}{
		{CodeUnauthorized, http.StatusUnauthorized},
		{CodeRateLimited, http.StatusTooManyRequests},
		{CodeForbidden, http.StatusForbidden},
		{CodeValidation, http.StatusBadRequest},
		{CodeNotFound, http.StatusNotFound},
		{CodeConflict, http.StatusConflict},
	}
	for _, test := range tests {
		if got := Status(New(test.code, "test")); got != test.want {
			t.Fatalf("Status(%s) = %d, want %d", test.code, got, test.want)
		}
	}
}

func TestErrorIncludesCause(t *testing.T) {
	t.Parallel()
	cause := errors.New("pq: duplicate key value violates unique constraint \"inv_warehouse_unique_name_per_company_index\"")
	wrapped := Wrap(CodeConflict, "仓库名称已存在", cause)
	want := "仓库名称已存在: " + cause.Error()
	if got := wrapped.Error(); got != want {
		t.Fatalf("Error() = %q, want %q", got, want)
	}
	if !errors.Is(wrapped, cause) {
		t.Fatal("errors.Is must still match the cause")
	}
	plain := New(CodeNotFound, "仓库不存在")
	if got := plain.Error(); got != "仓库不存在" {
		t.Fatalf("Error() without cause = %q", got)
	}
}
