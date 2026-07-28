// Package dberr 提供唯一的 PostgreSQL 写错误到 API 错误的映射组件。
//
// 历史上每个领域包各有一份 writeError 副本（23505 唯一冲突 / 23503 外键
// 引用 / 23514 check 等 → Conflict/Validation）。本包将映射逻辑收敛为一处：
// 各模块以「错误码/约束名 → 中文文案」的 Mapping 表声明差异，匹配与兜底
// 逻辑只写一遍。
package dberr

import (
	"errors"
	"strings"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
)

// Mapping 描述一条 PG 错误到 API 错误的映射规则，按声明顺序首个命中者生效。
type Mapping struct {
	// Code 为 PG SQLSTATE（如 "23505"）。空字符串表示匹配非 PG 错误，
	// 此时按 err.Error() 包含 Constraint 子串判断（用于驱动包装丢失
	// SQLSTATE 时兜底识别 duplicate key 等场景）。
	Code string
	// Constraint 可选；非空时要求 PG 约束名包含该子串（精确匹配是其特例）。
	Constraint string
	// Message 为对外中文文案。
	Message string
	// Validation 为 true 时映射为 400 validation，否则为 409 conflict。
	Validation bool
	// Bare 为 true 时使用 apierror.New（不保留 cause），用于历史行为
	// 即如此的位置；一般情况下保持 false（apierror.Wrap）。
	Bare bool
}

// MapWrite 将写路径错误映射为 API 错误：命中 mappings 时返回对应
// Conflict/Validation，否则返回 CodeInternal(fallback)。
func MapWrite(err error, fallback string, mappings ...Mapping) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		for _, m := range mappings {
			if m.Code == "" || m.Code != pgErr.Code {
				continue
			}
			if m.Constraint != "" && !strings.Contains(pgErr.ConstraintName, m.Constraint) {
				continue
			}
			return m.err(err)
		}
		return apierror.Wrap(apierror.CodeInternal, fallback, err)
	}
	for _, m := range mappings {
		if m.Code != "" || m.Constraint == "" {
			continue
		}
		if strings.Contains(err.Error(), m.Constraint) {
			return m.err(err)
		}
	}
	return apierror.Wrap(apierror.CodeInternal, fallback, err)
}

func (m Mapping) err(cause error) error {
	code := apierror.CodeConflict
	if m.Validation {
		code = apierror.CodeValidation
	}
	if m.Bare {
		return apierror.New(code, m.Message)
	}
	return apierror.Wrap(code, m.Message, cause)
}

// GenericMappings 是 banking / finance-documents / hr-operations 三包历史
// 一致的通用映射表，作为导出常量供仍需要它的模块复用。
func GenericMappings() []Mapping {
	return []Mapping{
		{Code: "23505", Message: "记录违反唯一约束"},
		{Code: "23503", Message: "记录已被引用或引用对象不存在"},
		{Code: "23514", Message: "记录参数不合法", Validation: true},
		{Code: "23502", Message: "记录参数不合法", Validation: true},
		{Code: "22P02", Message: "记录参数不合法", Validation: true},
		{Code: "40001", Message: "并发操作冲突,请重试"},
		{Code: "40P01", Message: "并发操作冲突,请重试"},
	}
}
