package listexec

import (
	"errors"
	"testing"

	"github.com/z1coyan/synie/server/internal/platform/apierror"
)

func TestValidatePage(t *testing.T) {
	if err := ValidatePage(20, 0); err != nil {
		t.Fatalf("合法分页不应报错: %v", err)
	}
	if err := ValidatePage(1, 0); err != nil {
		t.Fatalf("下边界应合法: %v", err)
	}
	if err := ValidatePage(200, 0); err != nil {
		t.Fatalf("上边界应合法: %v", err)
	}
	assertFields := func(limit, offset int, wantKeys ...string) {
		t.Helper()
		err := ValidatePage(limit, offset)
		var apiErr *apierror.Error
		if !errors.As(err, &apiErr) {
			t.Fatalf("期望 validation 错误, 得到 %v", err)
		}
		if apiErr.Code != apierror.CodeValidation || apiErr.Message != "分页参数不合法" {
			t.Fatalf("错误形态不符: %+v", apiErr)
		}
		if len(apiErr.Fields) != len(wantKeys) {
			t.Fatalf("字段数不符: %+v", apiErr.Fields)
		}
		for _, key := range wantKeys {
			if len(apiErr.Fields[key]) == 0 {
				t.Fatalf("缺少字段 %s: %+v", key, apiErr.Fields)
			}
		}
	}
	assertFields(0, 0, "limit")
	assertFields(201, 0, "limit")
	assertFields(20, -1, "offset")
	assertFields(0, -1, "limit", "offset")
	if got := ValidatePage(0, -1); got == nil {
		t.Fatal("应报错")
	}
	if fields := func() map[string][]string {
		var apiErr *apierror.Error
		errors.As(ValidatePage(0, -1), &apiErr)
		return apiErr.Fields
	}(); fields["limit"][0] != "必须在 1 到 200 之间" || fields["offset"][0] != "不能小于 0" {
		t.Fatalf("文案必须保持不变: %+v", fields)
	}
}
