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
	"github.com/z1coyan/synie/server/internal/platform/audit"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

func (s *Service) GetRule(ctx context.Context, id uuid.UUID) (Rule, error) {
	rule, err := scanRule(s.pool.QueryRow(ctx, `
		SELECT id,resource,name,to_json(segments),per_company,enabled,inserted_at,updated_at
		FROM sys_numbering_rule WHERE id=$1
	`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return Rule{}, apierror.New(apierror.CodeNotFound, "编号规则不存在")
	}
	if err != nil {
		return Rule{}, apierror.Wrap(apierror.CodeInternal, "读取编号规则失败", err)
	}
	return rule, nil
}

func (s *Service) ListRules(ctx context.Context, query RuleListQuery) (RuleList, error) {
	if query.Limit == 0 {
		query.Limit = 20
	}
	if query.Limit < 1 || query.Limit > 200 || query.Offset < 0 {
		return RuleList{}, apierror.Validation("分页参数不合法", map[string][]string{"limit": {"必须在 1 到 200 之间"}})
	}
	built, err := filterbuild.Build(RuleResourceMeta(), filterbuild.Query{
		Limit: query.Limit, Offset: query.Offset, Search: query.Search,
		Sort: query.Sort, Filter: query.Filter,
	})
	if err != nil {
		return RuleList{}, err
	}
	order := built.OrderBy
	if order == "" {
		order = ` ORDER BY "inserted_at" DESC, "id"`
	} else {
		order += `, "id"`
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return RuleList{}, apierror.Wrap(apierror.CodeInternal, "查询编号规则失败", err)
	}
	defer tx.Rollback(ctx)
	var result RuleList
	if err := tx.QueryRow(ctx, "SELECT count(*) FROM sys_numbering_rule"+built.Where, built.Args...).Scan(&result.Count); err != nil {
		return result, apierror.Wrap(apierror.CodeInternal, "统计编号规则失败", err)
	}
	args := append([]any(nil), built.Args...)
	limitIndex := len(args) + 1
	args = append(args, query.Limit, query.Offset)
	rows, err := tx.Query(ctx, `
		SELECT id,resource,name,to_json(segments),per_company,enabled,inserted_at,updated_at
		FROM sys_numbering_rule`+built.Where+order+
		fmt.Sprintf(" LIMIT $%d OFFSET $%d", limitIndex, limitIndex+1), args...)
	if err != nil {
		return result, apierror.Wrap(apierror.CodeInternal, "查询编号规则失败", err)
	}
	defer rows.Close()
	result.Results = make([]Rule, 0, query.Limit)
	for rows.Next() {
		rule, scanErr := scanRule(rows)
		if scanErr != nil {
			return result, apierror.Wrap(apierror.CodeInternal, "读取编号规则结果失败", scanErr)
		}
		result.Results = append(result.Results, rule)
	}
	if err := rows.Err(); err != nil {
		return result, apierror.Wrap(apierror.CodeInternal, "遍历编号规则结果失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return result, apierror.Wrap(apierror.CodeInternal, "完成编号规则查询失败", err)
	}
	return result, nil
}

func (s *Service) UpdateRule(
	ctx context.Context,
	actor *authz.Actor,
	id uuid.UUID,
	input UpdateInput,
) (Rule, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Rule{}, apierror.Wrap(apierror.CodeInternal, "更新编号规则失败", err)
	}
	defer tx.Rollback(ctx)
	before, err := scanRule(tx.QueryRow(ctx, `
		SELECT id,resource,name,to_json(segments),per_company,enabled,inserted_at,updated_at
		FROM sys_numbering_rule WHERE id=$1 FOR UPDATE
	`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return Rule{}, apierror.New(apierror.CodeNotFound, "编号规则不存在")
	}
	if err != nil {
		return Rule{}, apierror.Wrap(apierror.CodeInternal, "读取编号规则失败", err)
	}
	after := before
	if input.Name != nil {
		after.Name = *input.Name
	}
	if input.Segments != nil {
		after.Segments = *input.Segments
	}
	if input.PerCompany != nil {
		after.PerCompany = *input.PerCompany
	}
	if input.Enabled != nil {
		after.Enabled = *input.Enabled
	}
	if err := validateCreate(&CreateInput{
		Resource: after.Resource, Name: after.Name, Segments: after.Segments,
		PerCompany: &after.PerCompany, Enabled: &after.Enabled,
	}, s.catalog); err != nil {
		return Rule{}, err
	}
	changes := audit.Diff(ruleSnapshot(before), ruleSnapshot(after), ruleAuditFields)
	if len(changes) == 0 {
		if err := tx.Commit(ctx); err != nil {
			return Rule{}, apierror.Wrap(apierror.CodeInternal, "更新编号规则失败", err)
		}
		return before, nil
	}
	rawSegments, err := json.Marshal(after.Segments)
	if err != nil {
		return Rule{}, apierror.Wrap(apierror.CodeInternal, "编码编号段失败", err)
	}
	after, err = scanRule(tx.QueryRow(ctx, `
		UPDATE sys_numbering_rule
		SET name=$2,
		    segments=ARRAY(SELECT value FROM jsonb_array_elements($3::jsonb)),
		    per_company=$4,enabled=$5,updated_at=(now() AT TIME ZONE 'utc')
		WHERE id=$1
		RETURNING id,resource,name,to_json(segments),per_company,enabled,inserted_at,updated_at
	`, id, after.Name, rawSegments, after.PerCompany, after.Enabled))
	if err != nil {
		return Rule{}, numberingWriteError("更新编号规则失败", err)
	}
	if err := audit.Write(ctx, tx, actor, audit.Entry{
		Resource: "sys_numbering_rule", RecordID: id, RecordLabel: after.Name,
		ActionType: "update", ActionName: "update", Changes: changes,
	}); err != nil {
		return Rule{}, apierror.Wrap(apierror.CodeInternal, "更新编号规则失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return Rule{}, numberingWriteError("更新编号规则失败", err)
	}
	return after, nil
}

func (s *Service) DeleteRule(ctx context.Context, actor *authz.Actor, id uuid.UUID) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除编号规则失败", err)
	}
	defer tx.Rollback(ctx)
	rule, err := scanRule(tx.QueryRow(ctx, `
		SELECT id,resource,name,to_json(segments),per_company,enabled,inserted_at,updated_at
		FROM sys_numbering_rule WHERE id=$1 FOR UPDATE
	`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return apierror.New(apierror.CodeNotFound, "编号规则不存在")
	}
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "读取编号规则失败", err)
	}
	if _, err := tx.Exec(ctx, "DELETE FROM sys_numbering_rule WHERE id=$1", id); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除编号规则失败", err)
	}
	if err := audit.Write(ctx, tx, actor, audit.Entry{
		Resource: "sys_numbering_rule", RecordID: id, RecordLabel: rule.Name,
		ActionType: "destroy", ActionName: "destroy",
		Changes: audit.Destroyed(ruleSnapshot(rule), ruleAuditFields),
	}); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除编号规则失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除编号规则失败", err)
	}
	return nil
}
