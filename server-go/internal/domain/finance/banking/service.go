// Package banking owns bank accounts, statement rows, import staging and
// bank-to-journal reconciliation behind one interface. Callers provide only
// stored-file, numbering, journal and GL adapters; locks, transactions,
// projections, authorization and audit stay local to this module.
package banking

import (
	"context"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/z1coyan/synie/server/internal/db/listexec"
	"github.com/z1coyan/synie/server/internal/engines/gl"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/audit"
	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/platform/dberr"
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

func listQuery(query ListQuery) listexec.Query {
	return listexec.Query{Limit: query.Limit, Offset: query.Offset, Search: query.Search,
		Sort: query.Sort, Filter: query.Filter}
}

func writeError(message string, err error) error {
	return dberr.MapWrite(err, message, dberr.GenericMappings()...)
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
