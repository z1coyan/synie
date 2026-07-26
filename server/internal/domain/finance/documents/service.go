// Package documents owns the finance source-document aggregates. Public
// methods enforce permission before observing records, and every state
// transition keeps source state, GL, reconciliation/todo and audit in one
// caller-owned PostgreSQL transaction.
package documents

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
	"github.com/z1coyan/synie/server/internal/domain/trading/reconciliation"
	"github.com/z1coyan/synie/server/internal/engines/gl"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/audit"
	"github.com/z1coyan/synie/server/internal/platform/authz"
	fileplatform "github.com/z1coyan/synie/server/internal/platform/files"
	"github.com/z1coyan/synie/server/internal/platform/numbering"
)

type Numberer interface {
	NextInTx(context.Context, pgx.Tx, numbering.NextInput) (string, error)
}

type FileReader interface {
	ReadStoredFile(context.Context, uuid.UUID) (fileplatform.File, []byte, error)
}

type OCRRecognizer interface {
	Recognize(context.Context, string, fileplatform.File, []byte) (map[string]any, error)
}

type Ledger interface {
	Post(context.Context, pgx.Tx, gl.Voucher, []gl.Entry, ...gl.PostOptions) error
	Cancel(context.Context, pgx.Tx, gl.VoucherRef) error
	Reverse(context.Context, pgx.Tx, gl.VoucherRef, time.Time) error
}

type Reconciliations interface {
	CloseFromInvoice(
		context.Context, pgx.Tx, *authz.Actor, reconciliation.Side, uuid.UUID,
	) (reconciliation.Head, error)
	ReopenFromInvoice(
		context.Context, pgx.Tx, *authz.Actor, reconciliation.Side, uuid.UUID,
	) (reconciliation.Head, error)
}

type Dependencies struct {
	Numberer        Numberer
	Files           FileReader
	OCR             OCRRecognizer
	Ledger          Ledger
	Reconciliations Reconciliations
}

type Service struct {
	pool            *pgxpool.Pool
	numberer        Numberer
	files           FileReader
	ocr             OCRRecognizer
	ledger          Ledger
	reconciliations Reconciliations
}

func NewService(pool *pgxpool.Pool, dependencies Dependencies) *Service {
	if dependencies.Numberer == nil {
		dependencies.Numberer = numbering.NewService(pool)
	}
	if dependencies.Ledger == nil {
		dependencies.Ledger = ledgerAdapter{}
	}
	if dependencies.OCR == nil {
		dependencies.OCR = NewAliyunOCR(pool, nil)
	}
	if dependencies.Reconciliations == nil {
		dependencies.Reconciliations = reconciliation.NewService(pool)
	}
	return &Service{
		pool: pool, numberer: dependencies.Numberer, files: dependencies.Files,
		ocr: dependencies.OCR, ledger: dependencies.Ledger,
		reconciliations: dependencies.Reconciliations,
	}
}

type ledgerAdapter struct{}

func (ledgerAdapter) Post(
	ctx context.Context, tx pgx.Tx, voucher gl.Voucher, entries []gl.Entry,
	options ...gl.PostOptions,
) error {
	return gl.Post(ctx, tx, voucher, entries, options...)
}

func (ledgerAdapter) Cancel(ctx context.Context, tx pgx.Tx, ref gl.VoucherRef) error {
	return gl.Cancel(ctx, tx, ref)
}

func (ledgerAdapter) Reverse(
	ctx context.Context, tx pgx.Tx, ref gl.VoucherRef, postingDate time.Time,
) error {
	return gl.Reverse(ctx, tx, ref, postingDate)
}

func requirePermission(actor *authz.Actor, permission string) error {
	if actor != nil && actor.HasPermission(permission) {
		return nil
	}
	return apierror.New(apierror.CodeForbidden, "无权限执行此操作")
}

func requireCompany(actor *authz.Actor, companyID uuid.UUID, label string) error {
	if actor != nil && actor.CanAccessCompany(companyID) {
		return nil
	}
	return apierror.New(apierror.CodeNotFound, label+"不存在")
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
	if len(fields) > 0 {
		return apierror.Validation("分页参数不合法", fields)
	}
	return nil
}

func parseDate(value, field string) (time.Time, error) {
	result, err := time.Parse("2006-01-02", strings.TrimSpace(value))
	if err != nil {
		return time.Time{}, apierror.Validation("日期参数不合法", map[string][]string{
			field: {"格式应为 YYYY-MM-DD"},
		})
	}
	return result, nil
}

func dateString(value time.Time) string {
	return value.Format("2006-01-02")
}

func datePointer(value pgtype.Date) *string {
	if !value.Valid {
		return nil
	}
	result := dateString(value.Time)
	return &result
}

func dateValue(value pgtype.Date) string {
	if !value.Valid {
		return ""
	}
	return dateString(value.Time)
}

func parseDecimal(value, field string, positive bool, nonnegative bool) (decimal.Decimal, error) {
	result, err := decimal.NewFromString(strings.TrimSpace(value))
	if err != nil {
		return decimal.Zero, apierror.Validation("数值参数不合法", map[string][]string{
			field: {"必须是十进制字符串"},
		})
	}
	if positive && !result.IsPositive() {
		return decimal.Zero, apierror.Validation("数值参数不合法", map[string][]string{
			field: {"必须大于零"},
		})
	}
	if nonnegative && result.IsNegative() {
		return decimal.Zero, apierror.Validation("数值参数不合法", map[string][]string{
			field: {"不能为负数"},
		})
	}
	return result, nil
}

func parseOptionalDecimal(
	value *string, field string, positive bool, nonnegative bool,
) (*decimal.Decimal, error) {
	if value == nil {
		return nil, nil
	}
	result, err := parseDecimal(*value, field, positive, nonnegative)
	if err != nil {
		return nil, err
	}
	return &result, nil
}

func decimalPointer(value pgtype.Numeric) *string {
	if !value.Valid || value.Int == nil || value.NaN ||
		value.InfinityModifier != pgtype.Finite {
		return nil
	}
	result := decimal.NewFromBigInt(value.Int, value.Exp).String()
	return &result
}

func decimalValue(value pgtype.Numeric) string {
	result := decimalPointer(value)
	if result == nil {
		return "0"
	}
	return *result
}

func lower(value string) string { return strings.ToLower(strings.TrimSpace(value)) }
func upper(value string) string { return strings.ToUpper(strings.TrimSpace(value)) }

func text(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}

func dateArg(value *string, field string) (any, error) {
	if value == nil {
		return nil, nil
	}
	parsed, err := parseDate(*value, field)
	if err != nil {
		return nil, err
	}
	return parsed, nil
}

func databaseWriteError(message string, err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "23505":
			return apierror.Wrap(apierror.CodeConflict, "记录违反唯一约束", err)
		case "23503":
			return apierror.Wrap(apierror.CodeConflict, "记录已被引用或引用对象不存在", err)
		case "23514", "23502", "22P02":
			return apierror.Wrap(apierror.CodeValidation, "记录参数不合法", err)
		case "40001", "40P01":
			return apierror.Wrap(apierror.CodeConflict, "并发操作冲突,请重试", err)
		}
	}
	return apierror.Wrap(apierror.CodeInternal, message, err)
}

func notFound(label string, err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return apierror.New(apierror.CodeNotFound, label+"不存在")
	}
	return apierror.Wrap(apierror.CodeInternal, "读取"+label+"失败", err)
}

func appendPredicate(where string, args []any, predicate string, values ...any) (string, []any) {
	for _, value := range values {
		args = append(args, value)
		predicate = strings.Replace(predicate, "?", fmt.Sprintf("$%d", len(args)), 1)
	}
	if where == "" {
		return " WHERE " + predicate, args
	}
	return where + " AND " + predicate, args
}

func appendPagination(sql string, args []any, query ListQuery) (string, []any) {
	args = append(args, query.Limit)
	sql += fmt.Sprintf(" LIMIT $%d", len(args))
	args = append(args, query.Offset)
	sql += fmt.Sprintf(" OFFSET $%d", len(args))
	return sql, args
}

func companyScope(
	actor *authz.Actor, where string, args []any, column string,
) (string, []any) {
	return filterbuild.ApplyCompanyFilter(actor, where, args, column)
}

func billScope(actor *authz.Actor, where string, args []any, billColumn string) (string, []any) {
	ids, bypass, ok := filterbuild.CompanyIDsOrNil(actor)
	if bypass {
		return where, args
	}
	if !ok {
		if where == "" {
			return filterbuild.ImpossibleWhere, args
		}
		return where + " AND false", args
	}
	return appendPredicate(where, args, `EXISTS(
		SELECT 1 FROM acc_bill_transaction scope_tx
		WHERE scope_tx.bill_id=`+billColumn+` AND scope_tx.company_id=ANY(?::uuid[])
	)`, ids)
}

func writeAudit(
	ctx context.Context, tx pgx.Tx, actor *authz.Actor, resource string,
	recordID uuid.UUID, label, actionType, actionName string, companyID *uuid.UUID,
	changes map[string]audit.Change,
) error {
	if err := audit.Write(ctx, tx, actor, audit.Entry{
		Resource: resource, RecordID: recordID, RecordLabel: label,
		ActionType: actionType, ActionName: actionName, CompanyID: companyID,
		Changes: changes,
	}); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "写入审计日志失败", err)
	}
	return nil
}

func createdChanges(values map[string]any) map[string]audit.Change {
	return audit.Created(values, sortedKeys(values))
}

func changedValues(before, after map[string]any) map[string]audit.Change {
	keys := sortedKeys(before)
	return audit.Diff(before, after, keys)
}

func sortedKeys(values map[string]any) []string {
	result := make([]string, 0, len(values))
	for key := range values {
		result = append(result, key)
	}
	slicesSort(result)
	return result
}

// Kept local so this package does not expose audit implementation details.
func slicesSort(values []string) {
	for index := 1; index < len(values); index++ {
		for cursor := index; cursor > 0 && values[cursor] < values[cursor-1]; cursor-- {
			values[cursor], values[cursor-1] = values[cursor-1], values[cursor]
		}
	}
}
