// Package banking owns bank accounts, statement rows, import staging and
// bank-to-journal reconciliation behind one interface. Callers provide only
// stored-file, numbering, journal and GL adapters; locks, transactions,
// projections, authorization and audit stay local to this module.
package banking

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
	"github.com/z1coyan/synie/server/internal/engines/gl"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/audit"
	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/platform/numbering"
)

type Service struct {
	pool      *pgxpool.Pool
	files     FileReader
	numberer  Numberer
	ledger    Ledger
	journals  QuickJournalWriter
	utcOffset time.Duration
}

type defaultLedger struct{}

func (defaultLedger) Post(
	ctx context.Context, tx pgx.Tx, voucher gl.Voucher, entries []gl.Entry,
	options ...gl.PostOptions,
) error {
	return gl.Post(ctx, tx, voucher, entries, options...)
}

func NewService(pool *pgxpool.Pool, deps Dependencies) *Service {
	if deps.Numberer == nil {
		deps.Numberer = numbering.NewService(pool)
	}
	if deps.Ledger == nil {
		deps.Ledger = defaultLedger{}
	}
	if deps.UTCOffset == 0 {
		deps.UTCOffset = 8 * time.Hour
	}
	service := &Service{
		pool: pool, files: deps.Files, numberer: deps.Numberer,
		ledger: deps.Ledger, utcOffset: deps.UTCOffset,
	}
	if deps.QuickJournals != nil {
		service.journals = deps.QuickJournals
	} else {
		service.journals = &quickJournalAdapter{
			numberer: service.numberer, ledger: service.ledger,
		}
	}
	return service
}

func require(actor *authz.Actor, prefix, action string) error {
	if actor != nil && actor.HasPermission(prefix+":"+action) {
		return nil
	}
	return apierror.New(apierror.CodeForbidden, "无权限执行银行业务操作")
}

func requireCompany(actor *authz.Actor, companyID uuid.UUID, label string) error {
	if actor != nil && actor.CanAccessCompany(companyID) {
		return nil
	}
	return apierror.New(apierror.CodeNotFound, label+"不存在")
}

func validatePage(query *ListQuery) error {
	if query.Limit == 0 {
		query.Limit = 20
	}
	if query.Limit < 1 || query.Limit > 200 || query.Offset < 0 {
		return apierror.Validation("分页参数不合法", map[string][]string{
			"limit": {"必须在 1 到 200 之间"}, "offset": {"不能小于 0"},
		})
	}
	return nil
}

func buildFilter(resourceName string, query ListQuery) (filterbuild.SQL, error) {
	var resource = BankAccountResourceMeta()
	switch resourceName {
	case BankTransactionResource:
		resource = BankTransactionResourceMeta()
	case BankImportTemplateResource:
		resource = BankImportTemplateResourceMeta()
	case BankImportResource:
		resource = BankImportResourceMeta()
	case BankImportItemResource:
		resource = BankImportItemResourceMeta()
	case BankReconciliationResource:
		resource = BankReconciliationResourceMeta()
	}
	return filterbuild.Build(resource, filterbuild.Query{
		Limit: query.Limit, Offset: query.Offset, Search: query.Search,
		Sort: query.Sort, Filter: query.Filter,
	})
}

func scopedWhere(actor *authz.Actor, where string, args []any, column string) (string, []any, bool) {
	where, args, empty := filterbuild.AppendCompanyFilter(actor, where, args, column)
	return where, args, !empty
}

func appendPage(sql string, args []any, query ListQuery) (string, []any) {
	n := len(args) + 1
	args = append(args, query.Limit, query.Offset)
	return sql + fmt.Sprintf(" LIMIT $%d OFFSET $%d", n, n+1), args
}

func actorID(actor *authz.Actor) *uuid.UUID {
	if actor == nil || actor.UserID == uuid.Nil {
		return nil
	}
	value := actor.UserID
	return &value
}

func validateRequiredText(fields map[string][]string, field, value string, max int) string {
	value = strings.TrimSpace(value)
	switch {
	case value == "":
		fields[field] = []string{"必填"}
	case utf8.RuneCountInString(value) > max:
		fields[field] = []string{fmt.Sprintf("最多 %d 个字符", max)}
	}
	return value
}

func validateOptionalText(fields map[string][]string, field string, value *string, max int) *string {
	if value == nil {
		return nil
	}
	trimmed := strings.TrimSpace(*value)
	if utf8.RuneCountInString(trimmed) > max {
		fields[field] = []string{fmt.Sprintf("最多 %d 个字符", max)}
	}
	return &trimmed
}

func writeError(message string, err error) error {
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

func notFound(label string) error {
	return apierror.New(apierror.CodeNotFound, label+"不存在")
}

func conflict(message string) error {
	return apierror.New(apierror.CodeConflict, message)
}

func validation(label string, fields map[string][]string) error {
	return apierror.Validation(label+"参数不合法", fields)
}

func writeAudit(
	ctx context.Context, tx pgx.Tx, actor *authz.Actor, resource string,
	id uuid.UUID, label, actionType, actionName string, companyID *uuid.UUID,
	changes map[string]audit.Change,
) error {
	if err := audit.Write(ctx, tx, actor, audit.Entry{
		Resource: resource, RecordID: id, RecordLabel: label,
		ActionType: actionType, ActionName: actionName,
		CompanyID: companyID, Changes: changes,
	}); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "写入审计日志失败", err)
	}
	return nil
}

func created(values map[string]any) map[string]audit.Change {
	result := make(map[string]audit.Change, len(values))
	for key, value := range values {
		if value != nil {
			result[key] = audit.Change{"to": value}
		}
	}
	return result
}

func destroyed(values map[string]any) map[string]audit.Change {
	result := make(map[string]audit.Change, len(values))
	for key, value := range values {
		if value != nil {
			result[key] = audit.Change{"from": value}
		}
	}
	return result
}

func lower(value string) string { return strings.ToLower(strings.TrimSpace(value)) }
func upper(value string) string { return strings.ToUpper(strings.TrimSpace(value)) }
