package dberr

import (
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
)

func pgError(code, constraint string) error {
	return &pgconn.PgError{Code: code, ConstraintName: constraint}
}

func apiErr(t *testing.T, err error) *apierror.Error {
	t.Helper()
	var target *apierror.Error
	if !errors.As(err, &target) {
		t.Fatalf("期望 *apierror.Error，得到 %T: %v", err, err)
	}
	return target
}

func TestMapWriteConstraintMatchInOrder(t *testing.T) {
	mappings := []Mapping{
		{Code: "23505", Constraint: "hr_employees_unique_code_index", Message: "员工编号已存在"},
		{Code: "23505", Message: "员工唯一字段已存在"},
	}
	err := apiErr(t, MapWrite(pgError("23505", "hr_employees_unique_code_index"), "兜底", mappings...))
	if err.Code != apierror.CodeConflict || err.Message != "员工编号已存在" {
		t.Fatalf("约束名命中失败: %+v", err)
	}
	err = apiErr(t, MapWrite(pgError("23505", "other_index"), "兜底", mappings...))
	if err.Message != "员工唯一字段已存在" {
		t.Fatalf("默认 23505 命中失败: %+v", err)
	}
}

func TestMapWriteValidationAndConflict(t *testing.T) {
	mappings := []Mapping{
		{Code: "23503", Message: "已被引用"},
		{Code: "23514", Message: "参数不符合约束", Validation: true},
	}
	if err := apiErr(t, MapWrite(pgError("23503", ""), "兜底", mappings...)); err.Code != apierror.CodeConflict {
		t.Fatalf("23503 应为 conflict: %+v", err)
	}
	err := apiErr(t, MapWrite(pgError("23514", ""), "兜底", mappings...))
	if err.Code != apierror.CodeValidation || err.Message != "参数不符合约束" {
		t.Fatalf("23514 应为 validation: %+v", err)
	}
}

func TestMapWriteFallbackInternal(t *testing.T) {
	err := apiErr(t, MapWrite(pgError("23505", "x"), "创建失败"))
	if err.Code != apierror.CodeInternal || err.Message != "创建失败" {
		t.Fatalf("无映射应回退 internal: %+v", err)
	}
	err = apiErr(t, MapWrite(errors.New("boom"), "创建失败"))
	if err.Code != apierror.CodeInternal || err.Message != "创建失败" {
		t.Fatalf("非 PG 错误应回退 internal: %+v", err)
	}
}

func TestMapWriteDuplicateKeyFallback(t *testing.T) {
	mappings := []Mapping{
		{Code: "23505", Message: "公司编号已存在"},
		{Constraint: "duplicate key", Message: "公司编号已存在"},
	}
	err := apiErr(t, MapWrite(errors.New("exec failed: duplicate key value violates"), "兜底", mappings...))
	if err.Code != apierror.CodeConflict || err.Message != "公司编号已存在" {
		t.Fatalf("duplicate key 兜底失败: %+v", err)
	}
}

func TestMapWriteBare(t *testing.T) {
	err := apiErr(t, MapWrite(pgError("23505", ""), "兜底",
		Mapping{Code: "23505", Message: "对账单号已存在", Bare: true}))
	if err.Cause != nil {
		t.Fatalf("Bare 不应保留 cause: %+v", err)
	}
	wrapped := apiErr(t, MapWrite(pgError("23505", ""), "兜底",
		Mapping{Code: "23505", Message: "x"}))
	if wrapped.Cause == nil {
		t.Fatal("默认应保留 cause")
	}
}

func TestGenericMappings(t *testing.T) {
	cases := []struct {
		code        string
		wantCode    apierror.Code
		wantMessage string
	}{
		{"23505", apierror.CodeConflict, "记录违反唯一约束"},
		{"23503", apierror.CodeConflict, "记录已被引用或引用对象不存在"},
		{"23514", apierror.CodeValidation, "记录参数不合法"},
		{"23502", apierror.CodeValidation, "记录参数不合法"},
		{"22P02", apierror.CodeValidation, "记录参数不合法"},
		{"40001", apierror.CodeConflict, "并发操作冲突,请重试"},
		{"40P01", apierror.CodeConflict, "并发操作冲突,请重试"},
	}
	for _, tc := range cases {
		err := apiErr(t, MapWrite(pgError(tc.code, ""), "兜底", GenericMappings()...))
		if err.Code != tc.wantCode || err.Message != tc.wantMessage {
			t.Fatalf("%s: 得到 %+v", tc.code, err)
		}
	}
}
