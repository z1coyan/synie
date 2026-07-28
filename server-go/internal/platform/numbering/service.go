package numbering

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/z1coyan/synie/server/internal/db/dbgen"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/audit"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

type Service struct {
	pool    *pgxpool.Pool
	catalog catalog
}

func NewService(pool *pgxpool.Pool) *Service {
	return &Service{pool: pool, catalog: loadCatalog()}
}

func (s *Service) NumberableResources() []NumberableResource {
	return s.catalog.PublicResources()
}

func (s *Service) Create(ctx context.Context, actor *authz.Actor, input CreateInput) (Rule, error) {
	if err := validateCreate(&input, s.catalog); err != nil {
		return Rule{}, err
	}
	perCompany := true
	if input.PerCompany != nil {
		perCompany = *input.PerCompany
	}
	enabled := true
	if input.Enabled != nil {
		enabled = *input.Enabled
	}
	rawSegments, err := json.Marshal(input.Segments)
	if err != nil {
		return Rule{}, apierror.Wrap(apierror.CodeInternal, "编码编号段失败", err)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Rule{}, apierror.Wrap(apierror.CodeInternal, "创建编号规则失败", err)
	}
	defer tx.Rollback(ctx)
	rule, err := scanRule(tx.QueryRow(ctx, `
		INSERT INTO sys_numbering_rule (resource,name,segments,per_company,enabled)
		VALUES ($1,$2,ARRAY(SELECT value FROM jsonb_array_elements($3::jsonb)), $4,$5)
		RETURNING id,resource,name,to_json(segments),per_company,enabled,inserted_at,updated_at
	`, input.Resource, input.Name, rawSegments, perCompany, enabled))
	if err != nil {
		return Rule{}, numberingWriteError("创建编号规则失败", err)
	}
	if err := audit.Write(ctx, tx, actor, audit.Entry{
		Resource: "sys_numbering_rule", RecordID: rule.ID, RecordLabel: rule.Name,
		ActionType: "create", ActionName: "create",
		Changes: audit.Created(ruleSnapshot(rule), ruleAuditFields),
	}); err != nil {
		return Rule{}, apierror.Wrap(apierror.CodeInternal, "创建编号规则失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return Rule{}, numberingWriteError("创建编号规则失败", err)
	}
	return rule, nil
}

func (s *Service) Next(ctx context.Context, input NextInput) (string, error) {
	return s.next(ctx, s.pool, input)
}

// NextInTx allocates a number inside the caller-owned transaction. Posting
// aggregates use this form so the counter, document, facts, and audit either
// commit or roll back together.
func (s *Service) NextInTx(ctx context.Context, tx pgx.Tx, input NextInput) (string, error) {
	return s.next(ctx, tx, input)
}

func (s *Service) next(ctx context.Context, db dbgen.DBTX, input NextInput) (string, error) {
	definition, ok := s.catalog.resource(input.Resource)
	if !ok {
		return "", apierror.Validation("取号参数不合法", map[string][]string{"resource": {"未知的绑定资源"}})
	}
	rule, err := scanRule(db.QueryRow(ctx, `
		SELECT id,resource,name,to_json(segments),per_company,enabled,inserted_at,updated_at
		FROM sys_numbering_rule WHERE resource=$1 AND enabled=true
	`, input.Resource))
	if errors.Is(err, pgx.ErrNoRows) {
		return "", apierror.New(apierror.CodeConflict, "未配置启用的编号规则")
	}
	if err != nil {
		return "", apierror.Wrap(apierror.CodeInternal, "读取编号规则失败", err)
	}
	parts := make([]renderedPart, 0, len(rule.Segments))
	for _, segment := range rule.Segments {
		switch segment.Type {
		case "text":
			parts = append(parts, renderedPart{text: stringValue(segment.Value)})
		case "seq":
			parts = append(parts, renderedPart{sequence: true})
		case "field":
			field := definition.byPath[stringValue(segment.Field)]
			value, resolveErr := s.resolveField(ctx, db, field, input.Values)
			if resolveErr != nil {
				return "", resolveErr
			}
			if value == nil || fmt.Sprint(value) == "" {
				continue
			}
			text, renderErr := renderField(value, segment.Format, field)
			if renderErr != nil {
				return "", renderErr
			}
			parts = append(parts, renderedPart{text: text})
		}
	}
	scopeText := ""
	for _, part := range parts {
		if !part.sequence {
			scopeText += part.text
		}
	}
	scopeKey := scopeText
	if rule.PerCompany {
		companyID, ok := uuidValue(input.Values["company_id"])
		if !ok {
			return "", apierror.Validation("无法自动取号", map[string][]string{"companyId": {"规则按公司计数,单据缺少公司或公司无编码"}})
		}
		var code string
		if err := db.QueryRow(ctx, "SELECT code FROM bas_company WHERE id=$1", companyID).Scan(&code); err != nil || strings.TrimSpace(code) == "" {
			return "", apierror.Validation("无法自动取号", map[string][]string{"companyId": {"规则按公司计数,单据缺少公司或公司无编码"}})
		}
		scopeKey = code + "|" + scopeText
	}
	sequence, err := dbgen.New(db).IncrementNumberingCounter(
		ctx,
		dbgen.IncrementNumberingCounterParams{RuleID: rule.ID, ScopeKey: scopeKey},
	)
	if err != nil {
		return "", apierror.Wrap(apierror.CodeInternal, "递增编号计数器失败", err)
	}
	var result strings.Builder
	for _, part := range parts {
		if !part.sequence {
			result.WriteString(part.text)
			continue
		}
		padding := 4
		for _, segment := range rule.Segments {
			if segment.Type == "seq" && segment.Padding != nil {
				padding = *segment.Padding
				break
			}
		}
		value := strconv.FormatInt(sequence, 10)
		if padding > 0 && len(value) < padding {
			result.WriteString(strings.Repeat("0", padding-len(value)))
		}
		result.WriteString(value)
	}
	return result.String(), nil
}

func (s *Service) listCountersByRule(ctx context.Context, query CounterListQuery) (CounterList, error) {
	if query.Limit == 0 {
		query.Limit = 20
	}
	if query.Limit < 1 || query.Limit > 200 || query.Offset < 0 {
		return CounterList{}, apierror.Validation("分页参数不合法", map[string][]string{"limit": {"必须在 1 到 200 之间"}})
	}
	where := ""
	args := []any{}
	if query.RuleID != nil {
		where = " WHERE rule_id=$1"
		args = append(args, *query.RuleID)
	}
	var result CounterList
	if err := s.pool.QueryRow(ctx, "SELECT count(*) FROM sys_numbering_counter"+where, args...).Scan(&result.Count); err != nil {
		return result, apierror.Wrap(apierror.CodeInternal, "统计编号计数器失败", err)
	}
	limitIndex := len(args) + 1
	args = append(args, query.Limit, query.Offset)
	rows, err := s.pool.Query(ctx, `
		SELECT id,rule_id,scope_key,value,inserted_at,updated_at
		FROM sys_numbering_counter`+where+
		fmt.Sprintf(" ORDER BY scope_key,id LIMIT $%d OFFSET $%d", limitIndex, limitIndex+1), args...)
	if err != nil {
		return result, apierror.Wrap(apierror.CodeInternal, "查询编号计数器失败", err)
	}
	defer rows.Close()
	result.Results = make([]Counter, 0, query.Limit)
	for rows.Next() {
		counter, scanErr := scanCounter(rows)
		if scanErr != nil {
			return result, apierror.Wrap(apierror.CodeInternal, "读取编号计数器失败", scanErr)
		}
		result.Results = append(result.Results, counter)
	}
	if err := rows.Err(); err != nil {
		return result, apierror.Wrap(apierror.CodeInternal, "遍历编号计数器失败", err)
	}
	return result, nil
}

func (s *Service) UpdateCounter(ctx context.Context, actor *authz.Actor, id uuid.UUID, value int64) (Counter, error) {
	if value < 0 {
		return Counter{}, apierror.Validation("计数器参数不合法", map[string][]string{"value": {"不能小于 0"}})
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Counter{}, apierror.Wrap(apierror.CodeInternal, "更新编号计数器失败", err)
	}
	defer tx.Rollback(ctx)
	before, err := scanCounter(tx.QueryRow(ctx, `
		SELECT id,rule_id,scope_key,value,inserted_at,updated_at
		FROM sys_numbering_counter WHERE id=$1 FOR UPDATE
	`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return Counter{}, apierror.New(apierror.CodeNotFound, "编号计数器不存在")
	}
	if err != nil {
		return Counter{}, apierror.Wrap(apierror.CodeInternal, "读取编号计数器失败", err)
	}
	after, err := scanCounter(tx.QueryRow(ctx, `
		UPDATE sys_numbering_counter
		SET value=$2,updated_at=(now() AT TIME ZONE 'utc')
		WHERE id=$1
		RETURNING id,rule_id,scope_key,value,inserted_at,updated_at
	`, id, value))
	if err != nil {
		return Counter{}, apierror.Wrap(apierror.CodeInternal, "更新编号计数器失败", err)
	}
	changes := audit.Diff(counterSnapshot(before), counterSnapshot(after), counterAuditFields)
	if len(changes) > 0 {
		if err := audit.Write(ctx, tx, actor, audit.Entry{
			Resource: "sys_numbering_counter", RecordID: id, RecordLabel: after.ScopeKey,
			ActionType: "update", ActionName: "update", Changes: changes,
		}); err != nil {
			return Counter{}, apierror.Wrap(apierror.CodeInternal, "更新编号计数器失败", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return Counter{}, apierror.Wrap(apierror.CodeInternal, "更新编号计数器失败", err)
	}
	return after, nil
}

type scanner interface{ Scan(...any) error }

func scanRule(row scanner) (Rule, error) {
	var rule Rule
	var raw []byte
	err := row.Scan(
		&rule.ID, &rule.Resource, &rule.Name, &raw, &rule.PerCompany, &rule.Enabled,
		&rule.InsertedAt, &rule.UpdatedAt,
	)
	if err != nil {
		return Rule{}, err
	}
	rule.Segments, err = decodeSegments(raw)
	rule.InsertedAt = rule.InsertedAt.UTC()
	rule.UpdatedAt = rule.UpdatedAt.UTC()
	return rule, err
}

func scanCounter(row scanner) (Counter, error) {
	var counter Counter
	err := row.Scan(
		&counter.ID, &counter.RuleID, &counter.ScopeKey, &counter.Value,
		&counter.InsertedAt, &counter.UpdatedAt,
	)
	counter.InsertedAt = counter.InsertedAt.UTC()
	counter.UpdatedAt = counter.UpdatedAt.UTC()
	return counter, err
}

func (s *Service) resolveField(
	ctx context.Context,
	db dbgen.DBTX,
	field catalogField,
	values map[string]any,
) (any, error) {
	value, exists := values[field.SourceField]
	if !exists || value == nil {
		return nil, nil
	}
	if field.Lookup == nil {
		return value, nil
	}
	id, ok := uuidValue(value)
	if !ok {
		return nil, nil
	}
	statement := fmt.Sprintf(
		`SELECT %s::text FROM %s WHERE id=$1`,
		field.Lookup.ValueColumn, field.Lookup.Table,
	)
	var resolved *string
	if err := db.QueryRow(ctx, statement, id).Scan(&resolved); errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	} else if err != nil {
		return nil, apierror.Wrap(apierror.CodeInternal, "读取编号关联字段失败", err)
	}
	if resolved == nil {
		return nil, nil
	}
	return *resolved, nil
}

func renderField(value any, format *string, field catalogField) (string, error) {
	if field.Type != "date" && field.Type != "datetime" {
		if format != nil {
			return "", apierror.New(apierror.CodeValidation, "编号字段格式仅适用于日期")
		}
		return fmt.Sprint(value), nil
	}
	date, ok := dateValue(value)
	if !ok || format == nil {
		return "", apierror.New(apierror.CodeValidation, "编号日期字段值不合法")
	}
	result := *format
	result = strings.ReplaceAll(result, "YYYY", date.Format("2006"))
	result = strings.ReplaceAll(result, "YY", date.Format("06"))
	result = strings.ReplaceAll(result, "MM", date.Format("01"))
	result = strings.ReplaceAll(result, "DD", date.Format("02"))
	return result, nil
}

func dateValue(value any) (time.Time, bool) {
	switch typed := value.(type) {
	case time.Time:
		return typed, true
	case *time.Time:
		if typed != nil {
			return *typed, true
		}
	case string:
		for _, layout := range []string{"2006-01-02", time.RFC3339, "2006-01-02 15:04:05"} {
			if parsed, err := time.Parse(layout, typed); err == nil {
				return parsed, true
			}
		}
	case *string:
		if typed != nil {
			return dateValue(*typed)
		}
	}
	return time.Time{}, false
}

func uuidValue(value any) (uuid.UUID, bool) {
	switch typed := value.(type) {
	case uuid.UUID:
		return typed, typed != uuid.Nil
	case *uuid.UUID:
		if typed != nil {
			return *typed, *typed != uuid.Nil
		}
	case string:
		id, err := uuid.Parse(typed)
		return id, err == nil
	}
	return uuid.Nil, false
}

func stringValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func numberingWriteError(message string, err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		return apierror.Wrap(apierror.CodeConflict, "该资源已有启用的编号规则,同一资源只能启用一条", err)
	}
	return apierror.Wrap(apierror.CodeInternal, message, err)
}

type renderedPart struct {
	text     string
	sequence bool
}

var ruleAuditFields = []string{"resource", "name", "segments", "per_company", "enabled"}
var counterAuditFields = []string{"value"}

func ruleSnapshot(rule Rule) map[string]any {
	return map[string]any{
		"resource": rule.Resource, "name": rule.Name, "segments": rule.Segments,
		"per_company": rule.PerCompany, "enabled": rule.Enabled,
	}
}

func counterSnapshot(counter Counter) map[string]any {
	return map[string]any{"value": counter.Value}
}
