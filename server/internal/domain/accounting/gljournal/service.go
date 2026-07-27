package gljournal

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/db/dbgen"
	"github.com/z1coyan/synie/server/internal/db/listexec"
	"github.com/z1coyan/synie/server/internal/db/pgconv"
	"github.com/z1coyan/synie/server/internal/engines/gl"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/audit"
	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/platform/dberr"
	"github.com/z1coyan/synie/server/internal/platform/numbering"
)

type Numberer interface {
	NextInTx(context.Context, pgx.Tx, numbering.NextInput) (string, error)
}

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

func (s *Service) Get(ctx context.Context, actor *authz.Actor, id uuid.UUID) (Journal, error) {
	if err := require(actor, "read"); err != nil {
		return Journal{}, err
	}
	row, err := dbgen.New(s.pool).GetGLJournal(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Journal{}, notFound()
	}
	if err != nil {
		return Journal{}, apierror.Wrap(apierror.CodeInternal, "读取会计凭证失败", err)
	}
	if !actor.CanAccessCompany(row.CompanyID) {
		return Journal{}, notFound()
	}
	return journalFromRow(row), nil
}

func (s *Service) List(ctx context.Context, actor *authz.Actor, query ListQuery) (ListResult, error) {
	if err := require(actor, "read"); err != nil {
		return ListResult{}, err
	}
	ordinaryFilter, lineFilter, err := splitJournalLineFilter(query.Filter)
	if err != nil {
		return ListResult{}, err
	}
	result, err := listexec.List(ctx, listexec.Spec[Journal]{
		Pool: s.pool, Resource: ResourceMeta(), Label: "会计凭证", Actor: actor,
		Source: journalListSource,
		Select: `SELECT id,voucher_no,date,posting_date,remarks,status,
submitted_at,inserted_at,updated_at,company_id,created_by_id,submitted_by_id,
debit_total,credit_total,company_name,created_by_name,submitted_by_name`,
		DefaultOrder: ` ORDER BY "date" DESC, "voucher_no" ASC, "id" ASC`,
		Tiebreaker:   `, "id" ASC`,
		AdjustWhere: func(where string, args []any) (string, []any) {
			if lineFilter == nil {
				return where, args
			}
			accountAt := len(args) + 1
			amountAt := accountAt + 1
			clause := fmt.Sprintf(
				`EXISTS (SELECT 1 FROM acc_gl_journal_line lf
				 WHERE lf.journal_id=journals.id AND lf.account_id=$%d AND lf.%s>$%d)`,
				accountAt, lineFilter.side, amountAt,
			)
			if where == "" {
				where = " WHERE " + clause
			} else {
				where += " AND " + clause
			}
			return where, append(args, lineFilter.accountID, lineFilter.amount)
		},
		Scan: func(rows pgx.Rows) (Journal, error) {
			return scanJournal(rows)
		},
	}, listexec.Query{Limit: query.Limit, Offset: query.Offset, Search: query.Search,
		Sort: query.Sort, Filter: ordinaryFilter})
	if err != nil {
		return ListResult{}, err
	}
	return ListResult{Count: result.Count, Results: result.Results}, nil
}

const journalListSource = ` FROM (
SELECT j.id,j.voucher_no,j.date,j.posting_date,j.remarks,j.status,
  j.submitted_at,j.inserted_at,j.updated_at,j.company_id,j.created_by_id,
  j.submitted_by_id,
  COALESCE(sum(l.debit),0)::numeric AS debit_total,
  COALESCE(sum(l.credit),0)::numeric AS credit_total,
  c.name AS company_name,creator.name AS created_by_name,
  submitter.name AS submitted_by_name
FROM acc_gl_journal j
JOIN bas_company c ON c.id=j.company_id
LEFT JOIN sys_user creator ON creator.id=j.created_by_id
LEFT JOIN sys_user submitter ON submitter.id=j.submitted_by_id
LEFT JOIN acc_gl_journal_line l ON l.journal_id=j.id
GROUP BY j.id,c.name,creator.name,submitter.name
) AS journals`

func (s *Service) Create(ctx context.Context, actor *authz.Actor, input CreateInput) (Journal, error) {
	if err := require(actor, "create"); err != nil {
		return Journal{}, err
	}
	if !actor.CanAccessCompany(input.CompanyID) {
		return Journal{}, apierror.New(apierror.CodeForbidden, "无权操作该公司数据")
	}
	if err := validateCreate(input); err != nil {
		return Journal{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Journal{}, apierror.Wrap(apierror.CodeInternal, "创建会计凭证失败", err)
	}
	defer tx.Rollback(ctx)
	voucherNo := ""
	if input.VoucherNo != nil {
		voucherNo = strings.TrimSpace(*input.VoucherNo)
	}
	if voucherNo == "" {
		voucherNo, err = s.numberer.NextInTx(ctx, tx, numbering.NextInput{
			Resource: "acc.gl_journal",
			Values: map[string]any{
				"company_id": input.CompanyID,
				"date":       input.Date,
			},
		})
		if err != nil {
			return Journal{}, err
		}
	}
	if utf8.RuneCountInString(voucherNo) > 32 {
		return Journal{}, validation("voucherNo", "最多 32 个字符")
	}
	var createdByID *uuid.UUID
	if actor.UserID != uuid.Nil {
		createdByID = &actor.UserID
	}
	q := dbgen.New(tx)
	row, err := q.CreateGLJournal(ctx, dbgen.CreateGLJournalParams{
		VoucherNo: voucherNo, Date: pgconv.DateAlways(input.Date),
		PostingDate: pgconv.NullableDate(input.PostingDate), Remarks: pgconv.Text(input.Remarks),
		CompanyID: input.CompanyID, CreatedByID: createdByID,
	})
	if err != nil {
		return Journal{}, writeError("创建会计凭证失败", err)
	}
	projected, err := q.GetGLJournal(ctx, row.ID)
	if err != nil {
		return Journal{}, apierror.Wrap(apierror.CodeInternal, "读取新建会计凭证失败", err)
	}
	item := journalFromRow(projected)
	if err := writeJournalAudit(ctx, tx, actor, item, "create", "create",
		audit.Created(journalSnapshot(item), journalAuditFields)); err != nil {
		return Journal{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Journal{}, writeError("创建会计凭证失败", err)
	}
	return item, nil
}

func (s *Service) Update(ctx context.Context, actor *authz.Actor, id uuid.UUID, input UpdateInput) (Journal, error) {
	if err := require(actor, "update"); err != nil {
		return Journal{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Journal{}, apierror.Wrap(apierror.CodeInternal, "更新会计凭证失败", err)
	}
	defer tx.Rollback(ctx)
	q := dbgen.New(tx)
	locked, err := q.LockGLJournal(ctx, id)
	if err := lockError(err, "锁定会计凭证失败"); err != nil {
		return Journal{}, err
	}
	if !actor.CanAccessCompany(locked.CompanyID) {
		return Journal{}, notFound()
	}
	if locked.Status != "draft" {
		return Journal{}, draftError()
	}
	before, err := q.GetGLJournal(ctx, id)
	if err != nil {
		return Journal{}, apierror.Wrap(apierror.CodeInternal, "读取会计凭证失败", err)
	}
	current := journalFromRow(before)
	if input.VoucherNo != nil {
		current.VoucherNo = strings.TrimSpace(*input.VoucherNo)
	}
	if input.Date != nil {
		current.Date = *input.Date
	}
	if input.PostingDate != nil {
		current.PostingDate = *input.PostingDate
	}
	if input.Remarks != nil {
		current.Remarks = *input.Remarks
	}
	if err := validateMutable(current); err != nil {
		return Journal{}, err
	}
	changes := audit.Diff(journalSnapshot(journalFromRow(before)), journalSnapshot(current), journalAuditFields)
	if len(changes) == 0 {
		if err := tx.Commit(ctx); err != nil {
			return Journal{}, writeError("更新会计凭证失败", err)
		}
		return journalFromRow(before), nil
	}
	if _, err := q.UpdateGLJournal(ctx, dbgen.UpdateGLJournalParams{
		ID: id, VoucherNo: current.VoucherNo, Date: pgconv.DateAlways(current.Date),
		PostingDate: pgconv.NullableDate(current.PostingDate), Remarks: pgconv.Text(current.Remarks),
	}); err != nil {
		return Journal{}, writeError("更新会计凭证失败", err)
	}
	after, err := q.GetGLJournal(ctx, id)
	if err != nil {
		return Journal{}, apierror.Wrap(apierror.CodeInternal, "读取更新后会计凭证失败", err)
	}
	item := journalFromRow(after)
	if err := writeJournalAudit(ctx, tx, actor, item, "update", "update", changes); err != nil {
		return Journal{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Journal{}, writeError("更新会计凭证失败", err)
	}
	return item, nil
}

func (s *Service) Delete(ctx context.Context, actor *authz.Actor, id uuid.UUID) error {
	if err := require(actor, "delete"); err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除会计凭证失败", err)
	}
	defer tx.Rollback(ctx)
	q := dbgen.New(tx)
	locked, err := q.LockGLJournal(ctx, id)
	if err := lockError(err, "锁定会计凭证失败"); err != nil {
		return err
	}
	if !actor.CanAccessCompany(locked.CompanyID) {
		return notFound()
	}
	if locked.Status != "draft" {
		return draftError()
	}
	before, err := q.GetGLJournal(ctx, id)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "读取会计凭证失败", err)
	}
	item := journalFromRow(before)
	if _, err := q.DeleteGLJournal(ctx, id); err != nil {
		return writeError("删除会计凭证失败", err)
	}
	if err := writeJournalAudit(ctx, tx, actor, item, "destroy", "destroy",
		audit.Destroyed(journalSnapshot(item), journalAuditFields)); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return writeError("删除会计凭证失败", err)
	}
	return nil
}

func (s *Service) Audit(ctx context.Context, actor *authz.Actor, id uuid.UUID, postingDate *time.Time) (Journal, error) {
	if err := require(actor, "audit"); err != nil {
		return Journal{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Journal{}, apierror.Wrap(apierror.CodeInternal, "审核会计凭证失败", err)
	}
	defer tx.Rollback(ctx)
	q := dbgen.New(tx)
	locked, err := q.LockGLJournal(ctx, id)
	if err := lockError(err, "锁定会计凭证失败"); err != nil {
		return Journal{}, err
	}
	if !actor.CanAccessCompany(locked.CompanyID) {
		return Journal{}, notFound()
	}
	if locked.Status != "draft" {
		return Journal{}, apierror.New(apierror.CodeConflict, "仅草稿凭证可审核")
	}
	effectiveDate := pgconv.OptionalDate(locked.PostingDate)
	if postingDate != nil {
		effectiveDate = postingDate
	}
	if effectiveDate == nil || effectiveDate.IsZero() {
		return Journal{}, validation("postingDate", "审核过账前必须填写过账日期")
	}
	lines, err := q.ListGLJournalLinesByJournal(ctx, id)
	if err != nil {
		return Journal{}, apierror.Wrap(apierror.CodeInternal, "读取会计凭证行失败", err)
	}
	entries := make([]gl.Entry, 0, len(lines))
	for _, row := range lines {
		line := lineFromListRow(row)
		if err := validatePersistedLine(ctx, q, locked.CompanyID, line); err != nil {
			return Journal{}, err
		}
		entries = append(entries, gl.Entry{
			AccountID: line.AccountID, CurrencyID: line.CurrencyID,
			Debit: line.Debit, Credit: line.Credit,
			PartyType: dbPartyPointer(line.PartyType), PartyID: line.PartyID,
			Remarks: line.Remarks,
		})
	}
	beforeRow, err := q.GetGLJournal(ctx, id)
	if err != nil {
		return Journal{}, apierror.Wrap(apierror.CodeInternal, "读取会计凭证失败", err)
	}
	before := journalFromRow(beforeRow)
	if err := gl.Post(ctx, tx, gl.Voucher{
		Type: "acc.gl_journal", ID: id, No: locked.VoucherNo,
		CompanyID: locked.CompanyID, PostingDate: *effectiveDate,
	}, entries); err != nil {
		return Journal{}, err
	}
	now := time.Now().UTC()
	var submittedByID *uuid.UUID
	if actor.UserID != uuid.Nil {
		submittedByID = &actor.UserID
	}
	if _, err := q.AuditGLJournal(ctx, dbgen.AuditGLJournalParams{
		ID: id, PostingDate: pgconv.DateAlways(*effectiveDate), SubmittedAt: pgconv.TimestampAlways(now),
		SubmittedByID: submittedByID,
	}); err != nil {
		return Journal{}, writeError("更新会计凭证审核状态失败", err)
	}
	afterRow, err := q.GetGLJournal(ctx, id)
	if err != nil {
		return Journal{}, apierror.Wrap(apierror.CodeInternal, "读取审核后会计凭证失败", err)
	}
	after := journalFromRow(afterRow)
	if err := writeJournalAudit(ctx, tx, actor, after, "update", "audit",
		audit.Diff(journalSnapshot(before), journalSnapshot(after), journalAuditFields)); err != nil {
		return Journal{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Journal{}, writeError("审核会计凭证失败", err)
	}
	return after, nil
}

func (s *Service) Cancel(ctx context.Context, actor *authz.Actor, id uuid.UUID) (Journal, error) {
	if err := require(actor, "cancel"); err != nil {
		return Journal{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Journal{}, apierror.Wrap(apierror.CodeInternal, "取消会计凭证失败", err)
	}
	defer tx.Rollback(ctx)
	q := dbgen.New(tx)
	locked, err := q.LockGLJournal(ctx, id)
	if err := lockError(err, "锁定会计凭证失败"); err != nil {
		return Journal{}, err
	}
	if !actor.CanAccessCompany(locked.CompanyID) {
		return Journal{}, notFound()
	}
	if locked.Status != "audited" {
		return Journal{}, apierror.New(apierror.CodeConflict, "仅已审核凭证可取消")
	}
	used, err := q.GLJournalHasBankReconciliation(ctx, id)
	if err != nil {
		return Journal{}, apierror.Wrap(apierror.CodeInternal, "检查银行对账引用失败", err)
	}
	if used {
		return Journal{}, apierror.New(apierror.CodeConflict, "凭证已用于银行对账,请先解除对账")
	}
	beforeRow, err := q.GetGLJournal(ctx, id)
	if err != nil {
		return Journal{}, apierror.Wrap(apierror.CodeInternal, "读取会计凭证失败", err)
	}
	if err := gl.Cancel(ctx, tx, gl.VoucherRef{Type: "acc.gl_journal", ID: id}); err != nil {
		return Journal{}, err
	}
	if _, err := q.CancelGLJournal(ctx, id); err != nil {
		return Journal{}, writeError("更新会计凭证取消状态失败", err)
	}
	afterRow, err := q.GetGLJournal(ctx, id)
	if err != nil {
		return Journal{}, apierror.Wrap(apierror.CodeInternal, "读取取消后会计凭证失败", err)
	}
	after := journalFromRow(afterRow)
	if err := writeJournalAudit(ctx, tx, actor, after, "update", "cancel",
		audit.Diff(journalSnapshot(journalFromRow(beforeRow)), journalSnapshot(after), journalAuditFields)); err != nil {
		return Journal{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Journal{}, writeError("取消会计凭证失败", err)
	}
	return after, nil
}

type journalLineFilter struct {
	accountID uuid.UUID
	side      string
	amount    decimal.Decimal
}

func splitJournalLineFilter(source map[string]json.RawMessage) (map[string]json.RawMessage, *journalLineFilter, error) {
	filter := make(map[string]json.RawMessage, len(source))
	for key, value := range source {
		if key != "lines" {
			filter[key] = value
		}
	}
	raw, ok := source["lines"]
	if !ok {
		return filter, nil, nil
	}
	var body struct {
		AccountID *struct {
			Eq string `json:"eq"`
		} `json:"accountId"`
		Debit *struct {
			GreaterThan string `json:"greaterThan"`
		} `json:"debit"`
		Credit *struct {
			GreaterThan string `json:"greaterThan"`
		} `json:"credit"`
	}
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&body); err != nil || body.AccountID == nil {
		return nil, nil, validation("lines", "行筛选格式错误")
	}
	accountID, err := uuid.Parse(body.AccountID.Eq)
	if err != nil {
		return nil, nil, validation("lines.accountId", "必须是 UUID")
	}
	if (body.Debit == nil) == (body.Credit == nil) {
		return nil, nil, validation("lines", "借方或贷方筛选必须且只能提供一个")
	}
	side, rawAmount := "debit", ""
	if body.Debit != nil {
		rawAmount = body.Debit.GreaterThan
	} else {
		side, rawAmount = "credit", body.Credit.GreaterThan
	}
	amount, err := decimal.NewFromString(rawAmount)
	if err != nil {
		return nil, nil, validation("lines."+side, "greaterThan 必须是 decimal string")
	}
	return filter, &journalLineFilter{accountID: accountID, side: side, amount: amount}, nil
}

func require(actor *authz.Actor, action string) error {
	if actor == nil || !actor.HasPermission("acc.gl_journal:"+action) {
		return apierror.New(apierror.CodeForbidden, "无权执行会计凭证操作")
	}
	return nil
}

func validateCreate(input CreateInput) error {
	fields := map[string][]string{}
	if input.CompanyID == uuid.Nil {
		fields["companyId"] = []string{"必填"}
	}
	if input.Date.IsZero() {
		fields["date"] = []string{"必填"}
	}
	if input.VoucherNo != nil && utf8.RuneCountInString(strings.TrimSpace(*input.VoucherNo)) > 32 {
		fields["voucherNo"] = []string{"最多 32 个字符"}
	}
	validateText(fields, "remarks", input.Remarks, 512)
	if len(fields) > 0 {
		return apierror.Validation("会计凭证参数不合法", fields)
	}
	return nil
}

func validateMutable(item Journal) error {
	fields := map[string][]string{}
	if strings.TrimSpace(item.VoucherNo) == "" {
		fields["voucherNo"] = []string{"必填"}
	} else if utf8.RuneCountInString(item.VoucherNo) > 32 {
		fields["voucherNo"] = []string{"最多 32 个字符"}
	}
	if item.Date.IsZero() {
		fields["date"] = []string{"必填"}
	}
	validateText(fields, "remarks", item.Remarks, 512)
	if len(fields) > 0 {
		return apierror.Validation("会计凭证参数不合法", fields)
	}
	return nil
}

func validateText(fields map[string][]string, field string, value *string, max int) {
	if value != nil && utf8.RuneCountInString(*value) > max {
		fields[field] = []string{fmt.Sprintf("最多 %d 个字符", max)}
	}
}

func validation(field, message string) error {
	return apierror.Validation("会计凭证参数不合法", map[string][]string{field: {message}})
}

func notFound() error {
	return apierror.New(apierror.CodeNotFound, "会计凭证不存在")
}

func draftError() error {
	return apierror.New(apierror.CodeConflict, "仅草稿凭证可修改或删除")
}

func lockError(err error, message string) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return notFound()
	}
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, message, err)
	}
	return nil
}

var writeMappings = []dberr.Mapping{
	{Code: "23505", Message: "同一公司内凭证编号必须唯一"},
	{Code: "23503", Message: "会计凭证参数不合法", Validation: true},
	{Code: "23514", Message: "会计凭证参数不合法", Validation: true},
	{Code: "23502", Message: "会计凭证参数不合法", Validation: true},
	{Code: "22001", Message: "会计凭证参数不合法", Validation: true},
}

func writeError(message string, err error) error {
	return dberr.MapWrite(err, message, writeMappings...)
}

func writeJournalAudit(ctx context.Context, tx pgx.Tx, actor *authz.Actor, item Journal, actionType, actionName string, changes map[string]audit.Change) error {
	if err := audit.Write(ctx, tx, actor, audit.Entry{
		Resource: "acc_gl_journal", RecordID: item.ID, RecordLabel: item.VoucherNo,
		ActionType: actionType, ActionName: actionName, CompanyID: &item.CompanyID,
		Changes: changes,
	}); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "写入会计凭证审计失败", err)
	}
	return nil
}

var journalAuditFields = []string{
	"voucher_no", "date", "posting_date", "remarks", "status", "submitted_at",
	"company_id", "created_by_id", "submitted_by_id",
}

func journalSnapshot(item Journal) map[string]any {
	return map[string]any{
		"voucher_no": item.VoucherNo, "date": item.Date, "posting_date": item.PostingDate,
		"remarks": item.Remarks, "status": item.Status, "submitted_at": item.SubmittedAt,
		"company_id": item.CompanyID, "created_by_id": item.CreatedByID,
		"submitted_by_id": item.SubmittedByID,
	}
}

type scanner interface{ Scan(...any) error }

func scanJournal(row scanner) (Journal, error) {
	var raw dbgen.GetGLJournalRow
	err := row.Scan(
		&raw.ID, &raw.VoucherNo, &raw.Date, &raw.PostingDate, &raw.Remarks,
		&raw.Status, &raw.SubmittedAt, &raw.InsertedAt, &raw.UpdatedAt,
		&raw.CompanyID, &raw.CreatedByID, &raw.SubmittedByID, &raw.DebitTotal,
		&raw.CreditTotal, &raw.CompanyName, &raw.CreatedByName, &raw.SubmittedByName,
	)
	return journalFromRow(raw), err
}

func journalFromRow(row dbgen.GetGLJournalRow) Journal {
	item := Journal{
		ID: row.ID, VoucherNo: row.VoucherNo, Date: row.Date.Time,
		PostingDate: pgconv.OptionalDate(row.PostingDate), Remarks: pgconv.TextPtr(row.Remarks),
		Status: Status(strings.ToUpper(row.Status)), SubmittedAt: pgconv.OptionalTime(row.SubmittedAt),
		InsertedAt: row.InsertedAt.Time.UTC(), UpdatedAt: row.UpdatedAt.Time.UTC(),
		CompanyID: row.CompanyID, CreatedByID: row.CreatedByID,
		SubmittedByID: row.SubmittedByID, DebitTotal: row.DebitTotal,
		CreditTotal: row.CreditTotal,
		Company:     NamedRef{ID: row.CompanyID, Name: row.CompanyName},
	}
	if row.CreatedByID != nil && row.CreatedByName.Valid {
		item.CreatedBy = &NamedRef{ID: *row.CreatedByID, Name: row.CreatedByName.String}
	}
	if row.SubmittedByID != nil && row.SubmittedByName.Valid {
		item.SubmittedBy = &NamedRef{ID: *row.SubmittedByID, Name: row.SubmittedByName.String}
	}
	return item
}

func dbPartyPointer(value *string) *string {
	if value == nil {
		return nil
	}
	result := strings.ToLower(*value)
	return &result
}
