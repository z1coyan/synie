package numbering

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
)

func (s *Service) GetCounter(ctx context.Context, id uuid.UUID) (Counter, error) {
	counter, err := scanCounter(s.pool.QueryRow(ctx, `
		SELECT id,rule_id,scope_key,value,inserted_at,updated_at
		FROM sys_numbering_counter WHERE id=$1
	`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return Counter{}, apierror.New(apierror.CodeNotFound, "编号计数器不存在")
	}
	if err != nil {
		return Counter{}, apierror.Wrap(apierror.CodeInternal, "读取编号计数器失败", err)
	}
	return counter, nil
}

func (s *Service) ListCounters(ctx context.Context, query CounterListQuery) (CounterList, error) {
	if query.Limit == 0 {
		query.Limit = 20
	}
	if query.Limit < 1 || query.Limit > 200 || query.Offset < 0 {
		return CounterList{}, apierror.Validation("分页参数不合法", map[string][]string{"limit": {"必须在 1 到 200 之间"}})
	}
	filter := make(map[string]json.RawMessage, len(query.Filter)+1)
	for name, value := range query.Filter {
		filter[name] = value
	}
	if query.RuleID != nil {
		raw, _ := json.Marshal(map[string]any{
			"kind": "fk", "values": []string{query.RuleID.String()},
		})
		filter["ruleId"] = raw
	}
	built, err := filterbuild.Build(CounterResourceMeta(), filterbuild.Query{
		Limit: query.Limit, Offset: query.Offset, Search: query.Search,
		Sort: query.Sort, Filter: filter,
	})
	if err != nil {
		return CounterList{}, err
	}
	order := built.OrderBy
	if order == "" {
		order = ` ORDER BY "scope_key", "id"`
	} else {
		order += `, "id"`
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return CounterList{}, apierror.Wrap(apierror.CodeInternal, "查询编号计数器失败", err)
	}
	defer tx.Rollback(ctx)
	var result CounterList
	if err := tx.QueryRow(ctx, "SELECT count(*) FROM sys_numbering_counter"+built.Where, built.Args...).Scan(&result.Count); err != nil {
		return result, apierror.Wrap(apierror.CodeInternal, "统计编号计数器失败", err)
	}
	args := append([]any(nil), built.Args...)
	limitIndex := len(args) + 1
	args = append(args, query.Limit, query.Offset)
	rows, err := tx.Query(ctx, `
		SELECT id,rule_id,scope_key,value,inserted_at,updated_at
		FROM sys_numbering_counter`+built.Where+order+
		fmt.Sprintf(" LIMIT $%d OFFSET $%d", limitIndex, limitIndex+1), args...)
	if err != nil {
		return result, apierror.Wrap(apierror.CodeInternal, "查询编号计数器失败", err)
	}
	defer rows.Close()
	result.Results = make([]Counter, 0, query.Limit)
	for rows.Next() {
		counter, scanErr := scanCounter(rows)
		if scanErr != nil {
			return result, apierror.Wrap(apierror.CodeInternal, "读取编号计数器结果失败", scanErr)
		}
		result.Results = append(result.Results, counter)
	}
	if err := rows.Err(); err != nil {
		return result, apierror.Wrap(apierror.CodeInternal, "遍历编号计数器结果失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return result, apierror.Wrap(apierror.CodeInternal, "完成编号计数器查询失败", err)
	}
	return result, nil
}
