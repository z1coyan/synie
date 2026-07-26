package execution

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/audit"
	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/platform/numbering"
)

type Numberer interface {
	NextInTx(context.Context, pgx.Tx, numbering.NextInput) (string, error)
}

// Service is the manufacturing-execution module. It owns all lifecycle,
// projection, stock and audit transactions for demands, work orders and
// production outputs.
type Service struct {
	pool     *pgxpool.Pool
	numberer Numberer
}

func NewService(pool *pgxpool.Pool, numberers ...Numberer) *Service {
	var numberer Numberer = numbering.NewService(pool)
	if len(numberers) > 0 && numberers[0] != nil {
		numberer = numberers[0]
	}
	return &Service{pool: pool, numberer: numberer}
}

func require(actor *authz.Actor, resource, action string) error {
	if actor == nil || !actor.HasPermission(resource+":"+action) {
		return apierror.New(apierror.CodeForbidden, "无权限执行该制造操作")
	}
	return nil
}

func requireCompany(actor *authz.Actor, companyID uuid.UUID) error {
	if actor == nil || !actor.CanAccessCompany(companyID) {
		return apierror.New(apierror.CodeForbidden, "无权访问该公司数据")
	}
	return nil
}

func validateList(query *ListQuery) error {
	if query.Limit == 0 {
		query.Limit = 20
	}
	if query.Limit < 1 || query.Limit > 200 || query.Offset < 0 {
		return apierror.Validation("分页参数不合法", map[string][]string{
			"limit": {"必须在 1 到 200 之间"},
		})
	}
	return nil
}

func scopedCompany(actor *authz.Actor, explicit *uuid.UUID) (string, []any, error) {
	if explicit != nil {
		if err := requireCompany(actor, *explicit); err != nil {
			return "", nil, err
		}
		return "company_id=$1", []any{*explicit}, nil
	}
	scope := filterbuild.ResolveCompanyScope(actor)
	if scope.Bypass {
		return "true", nil, nil
	}
	if scope.Empty {
		return "false", nil, nil
	}
	return "company_id=ANY($1::uuid[])", []any{scope.CompanyIDs}, nil
}

func writeAudit(
	ctx context.Context,
	tx pgx.Tx,
	actor *authz.Actor,
	resource string,
	recordID uuid.UUID,
	label, actionType, actionName string,
	companyID uuid.UUID,
	changes map[string]audit.Change,
) error {
	if len(changes) == 0 {
		return nil
	}
	if err := audit.Write(ctx, tx, actor, audit.Entry{
		Resource: resource, RecordID: recordID, RecordLabel: label,
		ActionType: actionType, ActionName: actionName, CompanyID: &companyID,
		Changes: changes,
	}); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "写入制造执行审计失败", err)
	}
	return nil
}

func writeError(message string, err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "23505":
			switch {
			case strings.Contains(pgErr.ConstraintName, "mfg_work_order_active_demand_item"):
				return apierror.Wrap(apierror.CodeConflict, "该需求行已有未作废生产工单", err)
			case strings.Contains(pgErr.ConstraintName, "mfg_demand_unique_demand_no"):
				return apierror.Wrap(apierror.CodeConflict, "需求单号已存在", err)
			case strings.Contains(pgErr.ConstraintName, "mfg_work_order_unique_work_order_no"):
				return apierror.Wrap(apierror.CodeConflict, "工单号已存在", err)
			case strings.Contains(pgErr.ConstraintName, "mfg_output_unique_output_no"):
				return apierror.Wrap(apierror.CodeConflict, "生产入库单号已存在", err)
			default:
				return apierror.Wrap(apierror.CodeConflict, "制造执行数据已存在", err)
			}
		case "23503":
			return apierror.Wrap(apierror.CodeConflict, "制造执行数据已被业务引用,不可删除", err)
		case "23502", "23514":
			return apierror.Wrap(apierror.CodeValidation, "制造执行参数不符合约束", err)
		}
	}
	return apierror.Wrap(apierror.CodeInternal, message, err)
}

func validateNo(no, field string) error {
	if strings.TrimSpace(no) == "" || utf8.RuneCountInString(no) > 32 {
		return apierror.Validation("单号参数不合法", map[string][]string{
			field: {"不能为空且最多 32 个字符"},
		})
	}
	return nil
}

func validateRemarks(remarks *string) error {
	if remarks != nil && utf8.RuneCountInString(*remarks) > 512 {
		return apierror.Validation("备注参数不合法", map[string][]string{
			"remarks": {"最多 512 个字符"},
		})
	}
	return nil
}

func text(value *string) pgtype.Text {
	if value == nil {
		return pgtype.Text{}
	}
	return pgtype.Text{String: *value, Valid: true}
}

func date(value time.Time) pgtype.Date {
	return pgtype.Date{Time: value, Valid: true}
}

func nullableDate(value *time.Time) pgtype.Date {
	if value == nil {
		return pgtype.Date{}
	}
	return date(*value)
}

func textPtr(value pgtype.Text) *string {
	if !value.Valid {
		return nil
	}
	return &value.String
}

func uuidPtr(value pgtype.UUID) *uuid.UUID {
	if !value.Valid {
		return nil
	}
	id := uuid.UUID(value.Bytes)
	return &id
}

func datePtr(value pgtype.Date) *time.Time {
	if !value.Valid {
		return nil
	}
	return &value.Time
}

func timestampPtr(value pgtype.Timestamp) *time.Time {
	if !value.Valid {
		return nil
	}
	return &value.Time
}

func todayUTC() time.Time {
	now := time.Now().UTC()
	return time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
}

func sortedUUIDs(values map[uuid.UUID]decimal.Decimal) []uuid.UUID {
	result := make([]uuid.UUID, 0, len(values))
	for id := range values {
		result = append(result, id)
	}
	sort.Slice(result, func(i, j int) bool {
		return result[i].String() < result[j].String()
	})
	return result
}

func actorID(actor *authz.Actor) *uuid.UUID {
	if actor == nil || actor.UserID == uuid.Nil {
		return nil
	}
	return &actor.UserID
}

func begin(ctx context.Context, pool *pgxpool.Pool, message string) (pgx.Tx, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return nil, apierror.Wrap(apierror.CodeInternal, message, err)
	}
	return tx, nil
}

func commit(ctx context.Context, tx pgx.Tx, message string) error {
	if err := tx.Commit(ctx); err != nil {
		return writeError(message, err)
	}
	return nil
}

func notFound(label string) error {
	return apierror.New(apierror.CodeNotFound, label+"不存在")
}

func conflict(message string) error {
	return apierror.New(apierror.CodeConflict, message)
}

func internal(message string, err error) error {
	return apierror.Wrap(apierror.CodeInternal, message, err)
}

func rowLockedMessage(label string, err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return notFound(label)
	}
	return internal("锁定"+label+"失败", err)
}

func snapshot(fields map[string]any) map[string]any {
	return fields
}

func created(fields map[string]any) map[string]audit.Change {
	keys := make([]string, 0, len(fields))
	for key := range fields {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return audit.Created(fields, keys)
}

func changed(before, after map[string]any) map[string]audit.Change {
	keys := make([]string, 0, len(after))
	for key := range after {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return audit.Diff(before, after, keys)
}

func destroyed(fields map[string]any) map[string]audit.Change {
	keys := make([]string, 0, len(fields))
	for key := range fields {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return audit.Destroyed(fields, keys)
}

func ensurePositive(value decimal.Decimal, field string) error {
	if !value.GreaterThan(decimal.Zero) {
		return apierror.Validation("数量参数不合法", map[string][]string{
			field: {"必须大于 0"},
		})
	}
	return nil
}

func optionalUUID(value *uuid.UUID) any {
	if value == nil {
		return nil
	}
	return *value
}

func optionalText(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}

func optionalTime(value *time.Time) any {
	if value == nil {
		return nil
	}
	return *value
}

func wrapLine(idx int64, message string) error {
	return conflict(fmt.Sprintf("第%d行:%s", idx, message))
}
