// Package listexec 收敛领域模块 List 方法的通用脚手架：
// 分页边界校验（1–200）→ filterbuild.Build → 公司隔离过滤 → 只读事务
// （RepeatableRead ReadOnly）→ count → LIMIT/OFFSET 分页查询 → 逐行 scan。
//
// count 与列表在同一事务内执行，保证一致性。错误文案按 Label 生成，与各
// 模块历史文案逐字一致（查询X失败/统计X失败/读取X结果失败/遍历X结果失败/
// 完成X查询失败）。
package listexec

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/platform/meta"
)

// Query 是执行器视角的分页查询参数，与各模块 ListQuery 字段一一对应。
type Query struct {
	Limit  int
	Offset int
	Search string
	Sort   *filterbuild.Sort
	Filter map[string]json.RawMessage
}

// Result 是分页查询结果。
type Result[T any] struct {
	Count   int64
	Results []T
}

// Spec 描述一次列表查询的全部模块差异。
type Spec[T any] struct {
	Pool     *pgxpool.Pool
	Resource meta.ResourceMeta
	// Label 为中文资源名，用于错误文案（如 "供应商"）。
	Label string
	// Source 为 " FROM ..." 数据源子句，count 与列表查询共用。
	Source string
	// Select 为列表查询的 "SELECT ..." 列清单（不含 Source）。
	Select string
	// DefaultOrder 为未指定排序时的 ORDER BY 子句（含前导空格）。
	DefaultOrder string
	// Tiebreaker 为指定排序时追加的稳定次序（如 `, "id" ASC`）。
	Tiebreaker string
	// DefaultLimit 为 Limit==0 时的默认页大小；0 表示 20。
	DefaultLimit int
	// Actor 非 nil 时按公司隔离过滤（空集合语义：无可见公司时追加
	// 永假条件，结果为空）。
	Actor *authz.Actor
	// CompanyColumn 为公司隔离列名，默认 "company_id"。
	CompanyColumn string
	// AdjustWhere 可选，在公司隔离过滤之前改写 where/args（如注入
	// EXISTS 子查询或额外谓词）。
	AdjustWhere func(where string, args []any) (string, []any)
	// RawTail 为 true 时 rows.Err()/Commit 错误原样透传（个别模块的
	// 历史行为）；否则包装为 "遍历X结果失败"/"完成X查询失败"。
	RawTail bool
	// Scan 逐行扫描。
	Scan func(rows pgx.Rows) (T, error)
}

// ValidatePage 是单点化的分页边界校验：limit 要求在 1–200 之间，offset
// 不能为负。调用方须先完成 Limit==0 的默认值处理。
func ValidatePage(limit, offset int) error {
	fields := map[string][]string{}
	if limit < 1 || limit > 200 {
		fields["limit"] = []string{"必须在 1 到 200 之间"}
	}
	if offset < 0 {
		fields["offset"] = []string{"不能小于 0"}
	}
	if len(fields) > 0 {
		return apierror.Validation("分页参数不合法", fields)
	}
	return nil
}

// List 执行通用分页列表查询：分页校验 → 筛选构建 → 公司隔离 → 只读事务内
// count + 分页查询 + 逐行扫描。
func List[T any](ctx context.Context, spec Spec[T], query Query) (Result[T], error) {
	limit := query.Limit
	if limit == 0 {
		limit = spec.DefaultLimit
		if limit == 0 {
			limit = 20
		}
	}
	if err := ValidatePage(limit, query.Offset); err != nil {
		return Result[T]{}, err
	}
	built, err := filterbuild.Build(spec.Resource, filterbuild.Query{
		Limit: limit, Offset: query.Offset, Search: query.Search,
		Sort: query.Sort, Filter: query.Filter,
	})
	if err != nil {
		return Result[T]{}, err
	}
	where, args := built.Where, append([]any(nil), built.Args...)
	if spec.AdjustWhere != nil {
		where, args = spec.AdjustWhere(where, args)
	}
	if spec.Actor != nil {
		column := spec.CompanyColumn
		if column == "" {
			column = "company_id"
		}
		where, args = filterbuild.ApplyCompanyFilter(spec.Actor, where, args, column)
	}
	order := built.OrderBy
	if order == "" {
		order = spec.DefaultOrder
	} else {
		order += spec.Tiebreaker
	}
	tx, err := spec.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return Result[T]{}, apierror.Wrap(apierror.CodeInternal, "查询"+spec.Label+"失败", err)
	}
	defer tx.Rollback(ctx)
	var result Result[T]
	if err := tx.QueryRow(ctx, `SELECT count(*)`+spec.Source+where, args...).Scan(&result.Count); err != nil {
		return Result[T]{}, apierror.Wrap(apierror.CodeInternal, "统计"+spec.Label+"失败", err)
	}
	listArgs := append(append([]any(nil), args...), limit, query.Offset)
	limitAt := len(args) + 1
	rows, err := tx.Query(ctx, spec.Select+spec.Source+where+order+
		fmt.Sprintf(" LIMIT $%d OFFSET $%d", limitAt, limitAt+1), listArgs...)
	if err != nil {
		return Result[T]{}, apierror.Wrap(apierror.CodeInternal, "查询"+spec.Label+"失败", err)
	}
	defer rows.Close()
	result.Results = make([]T, 0, limit)
	for rows.Next() {
		item, scanErr := spec.Scan(rows)
		if scanErr != nil {
			return Result[T]{}, apierror.Wrap(apierror.CodeInternal, "读取"+spec.Label+"结果失败", scanErr)
		}
		result.Results = append(result.Results, item)
	}
	if err := rows.Err(); err != nil {
		if spec.RawTail {
			return Result[T]{}, err
		}
		return Result[T]{}, apierror.Wrap(apierror.CodeInternal, "遍历"+spec.Label+"结果失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		if spec.RawTail {
			return Result[T]{}, err
		}
		return Result[T]{}, apierror.Wrap(apierror.CodeInternal, "完成"+spec.Label+"查询失败", err)
	}
	return result, nil
}
