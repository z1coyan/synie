package operations

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/audit"
	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/platform/dberr"
	fileplatform "github.com/z1coyan/synie/server/internal/platform/files"
	"github.com/z1coyan/synie/server/internal/platform/numbering"
)

type FileReader interface {
	ReadStoredFile(context.Context, uuid.UUID) (fileplatform.File, []byte, error)
}

type Numberer interface {
	NextInTx(context.Context, pgx.Tx, numbering.NextInput) (string, error)
}

type Service struct {
	pool     *pgxpool.Pool
	files    FileReader
	numberer Numberer
}

func NewService(pool *pgxpool.Pool, files FileReader, numberer Numberer) *Service {
	return &Service{pool: pool, files: files, numberer: numberer}
}

func requirePermission(actor *authz.Actor, permission string) error {
	if actor != nil && actor.HasPermission(permission) {
		return nil
	}
	return apierror.New(apierror.CodeForbidden, "无权限执行此操作")
}

func actorID(actor *authz.Actor) *uuid.UUID {
	if actor == nil || actor.UserID == uuid.Nil {
		return nil
	}
	value := actor.UserID
	return &value
}

func validateList(query *ListQuery) error {
	if query.Limit == 0 {
		query.Limit = 20
	}
	fields := map[string][]string{}
	if query.Limit < 1 || query.Limit > 200 {
		fields["limit"] = []string{"必须在 1 到 200 之间"}
	}
	if query.Offset < 0 {
		fields["offset"] = []string{"不能小于 0"}
	}
	if len(fields) != 0 {
		return apierror.Validation("分页参数不合法", fields)
	}
	return nil
}

func parseDate(value, field string) (time.Time, error) {
	parsed, err := time.Parse("2006-01-02", strings.TrimSpace(value))
	if err != nil {
		return time.Time{}, apierror.Validation("日期参数不合法", map[string][]string{
			field: {"格式应为 YYYY-MM-DD"},
		})
	}
	return parsed, nil
}

func parseMonth(value string) (time.Time, error) {
	if len(value) != 7 {
		return time.Time{}, apierror.Validation("月份参数不合法", map[string][]string{
			"month": {"格式应为 YYYY-MM"},
		})
	}
	parsed, err := time.Parse("2006-01", value)
	if err != nil {
		return time.Time{}, apierror.Validation("月份参数不合法", map[string][]string{
			"month": {"格式应为 YYYY-MM"},
		})
	}
	return parsed, nil
}

func parseDecimal(value, field string, nonnegative bool, nonzero bool) (decimal.Decimal, error) {
	parsed, err := decimal.NewFromString(strings.TrimSpace(value))
	if err != nil {
		return decimal.Zero, apierror.Validation("数值参数不合法", map[string][]string{
			field: {"必须是十进制字符串"},
		})
	}
	if nonnegative && parsed.IsNegative() {
		return decimal.Zero, apierror.Validation("数值参数不合法", map[string][]string{
			field: {"不能为负数"},
		})
	}
	if nonzero && parsed.IsZero() {
		return decimal.Zero, apierror.Validation("数值参数不合法", map[string][]string{
			field: {"不能为零"},
		})
	}
	return parsed, nil
}

func numeric(value decimal.Decimal) pgtype.Numeric {
	return pgtype.Numeric{Int: value.Coefficient(), Exp: value.Exponent(), Valid: true}
}

func numericString(value pgtype.Numeric) string {
	if !value.Valid || value.Int == nil || value.NaN || value.InfinityModifier != pgtype.Finite {
		return "0"
	}
	return decimal.NewFromBigInt(value.Int, value.Exp).String()
}

func nullableNumericString(value pgtype.Numeric) *string {
	if !value.Valid || value.Int == nil || value.NaN || value.InfinityModifier != pgtype.Finite {
		return nil
	}
	result := decimal.NewFromBigInt(value.Int, value.Exp).String()
	return &result
}

func databaseWriteError(message string, err error) error {
	return dberr.MapWrite(err, message, dberr.GenericMappings()...)
}

func writeAudit(
	ctx context.Context,
	tx pgx.Tx,
	actor *authz.Actor,
	resource string,
	recordID uuid.UUID,
	label, actionType, actionName string,
	changes map[string]audit.Change,
) error {
	if err := audit.Write(ctx, tx, actor, audit.Entry{
		Resource: resource, RecordID: recordID, RecordLabel: label,
		ActionType: actionType, ActionName: actionName, Changes: changes,
	}); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "写入审计日志失败", err)
	}
	return nil
}

func createdChanges(values map[string]any) map[string]audit.Change {
	result := make(map[string]audit.Change, len(values))
	for key, value := range values {
		if value != nil {
			result[key] = audit.Change{"to": value}
		}
	}
	return result
}

func destroyedChanges(values map[string]any) map[string]audit.Change {
	result := make(map[string]audit.Change, len(values))
	for key, value := range values {
		if value != nil {
			result[key] = audit.Change{"from": value}
		}
	}
	return result
}

func appendPagination(sql string, args []any, query ListQuery) (string, []any) {
	n := len(args) + 1
	args = append(args, query.Limit, query.Offset)
	return sql + fmt.Sprintf(" LIMIT $%d OFFSET $%d", n, n+1), args
}

func lowerWire(value string) string { return strings.ToLower(value) }
func upperWire(value string) string { return strings.ToUpper(value) }
