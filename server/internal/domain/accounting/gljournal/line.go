package gljournal

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/db/dbgen"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/audit"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

func (s *Service) GetLine(ctx context.Context, actor *authz.Actor, id uuid.UUID) (Line, error) {
	if err := require(actor, "read"); err != nil {
		return Line{}, err
	}
	row, err := dbgen.New(s.pool).GetGLJournalLine(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Line{}, lineNotFound()
	}
	if err != nil {
		return Line{}, apierror.Wrap(apierror.CodeInternal, "读取会计凭证行失败", err)
	}
	if !actor.CanAccessCompany(row.CompanyID) {
		return Line{}, lineNotFound()
	}
	return lineFromRow(row), nil
}

func (s *Service) ListLines(ctx context.Context, actor *authz.Actor, query ListLineQuery) (LineListResult, error) {
	if err := require(actor, "read"); err != nil {
		return LineListResult{}, err
	}
	if query.Limit == 0 {
		query.Limit = 20
	}
	if query.Limit < 1 || query.Limit > 200 || query.Offset < 0 {
		return LineListResult{}, paginationError()
	}
	built, err := filterbuild.Build(LineResourceMeta(), filterbuild.Query{
		Limit: query.Limit, Offset: query.Offset, Search: query.Search,
		Sort: query.Sort, Filter: query.Filter,
	})
	if err != nil {
		return LineListResult{}, err
	}
	where, args, empty := scopedWhere(actor, built.Where, built.Args)
	if empty {
		return LineListResult{Results: []Line{}}, nil
	}
	order := built.OrderBy
	if order == "" {
		order = ` ORDER BY "idx" ASC, "id" ASC`
	} else {
		order += `, "id" ASC`
	}
	const source = ` FROM (
		SELECT l.id,l.idx,l.debit,l.credit,l.party_type,l.party_id,l.remarks,
		  l.inserted_at,l.updated_at,l.journal_id,l.company_id,l.account_id,
		  l.currency_id,j.voucher_no,c.name AS company_name,a.code AS account_code,
		  a.name AS account_name,cur.iso_code AS currency_code,cur.name AS currency_name
		FROM acc_gl_journal_line l
		JOIN acc_gl_journal j ON j.id=l.journal_id
		JOIN bas_company c ON c.id=l.company_id
		JOIN bas_account a ON a.id=l.account_id
		LEFT JOIN bas_currency cur ON cur.id=l.currency_id
	) AS journal_lines`
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return LineListResult{}, apierror.Wrap(apierror.CodeInternal, "查询会计凭证行失败", err)
	}
	defer tx.Rollback(ctx)
	var result LineListResult
	if err := tx.QueryRow(ctx, `SELECT count(*)`+source+where, args...).Scan(&result.Count); err != nil {
		return LineListResult{}, apierror.Wrap(apierror.CodeInternal, "统计会计凭证行失败", err)
	}
	listArgs := append([]any(nil), args...)
	at := len(listArgs) + 1
	listArgs = append(listArgs, query.Limit, query.Offset)
	rows, err := tx.Query(ctx, `SELECT id,idx,debit,credit,party_type,party_id,remarks,
		inserted_at,updated_at,journal_id,company_id,account_id,currency_id,
		voucher_no,company_name,account_code,account_name,currency_code,currency_name`+
		source+where+order+fmt.Sprintf(" LIMIT $%d OFFSET $%d", at, at+1), listArgs...)
	if err != nil {
		return LineListResult{}, apierror.Wrap(apierror.CodeInternal, "查询会计凭证行失败", err)
	}
	defer rows.Close()
	result.Results = make([]Line, 0, query.Limit)
	for rows.Next() {
		item, scanErr := scanLine(rows)
		if scanErr != nil {
			return LineListResult{}, apierror.Wrap(apierror.CodeInternal, "读取会计凭证行结果失败", scanErr)
		}
		result.Results = append(result.Results, item)
	}
	if err := rows.Err(); err != nil {
		return LineListResult{}, apierror.Wrap(apierror.CodeInternal, "遍历会计凭证行结果失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return LineListResult{}, apierror.Wrap(apierror.CodeInternal, "完成会计凭证行查询失败", err)
	}
	return result, nil
}

func (s *Service) CreateLine(ctx context.Context, actor *authz.Actor, input CreateLineInput) (Line, error) {
	if err := require(actor, "create"); err != nil {
		return Line{}, err
	}
	if err := validateLineShape(input.Idx, input.AccountID, input.Debit, input.Credit, input.PartyType, input.PartyID, input.Remarks); err != nil {
		return Line{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Line{}, apierror.Wrap(apierror.CodeInternal, "创建会计凭证行失败", err)
	}
	defer tx.Rollback(ctx)
	q := dbgen.New(tx)
	journal, err := lockDraftJournal(ctx, q, actor, input.JournalID)
	if err != nil {
		return Line{}, err
	}
	currencyID, err := validateLineReferences(ctx, q, journal.CompanyID, input.AccountID, input.PartyType, input.PartyID)
	if err != nil {
		return Line{}, err
	}
	row, err := q.CreateGLJournalLine(ctx, dbgen.CreateGLJournalLineParams{
		Idx: input.Idx, Debit: input.Debit, Credit: input.Credit,
		PartyType: dbPartyText(input.PartyType), PartyID: input.PartyID,
		Remarks: text(input.Remarks), JournalID: journal.ID,
		CompanyID: journal.CompanyID, AccountID: input.AccountID, CurrencyID: currencyID,
	})
	if err != nil {
		return Line{}, writeError("创建会计凭证行失败", err)
	}
	projected, err := q.GetGLJournalLine(ctx, row.ID)
	if err != nil {
		return Line{}, apierror.Wrap(apierror.CodeInternal, "读取新建会计凭证行失败", err)
	}
	item := lineFromRow(projected)
	if err := writeLineAudit(ctx, tx, actor, item, "create", "create",
		audit.Created(lineSnapshot(item), lineAuditFields)); err != nil {
		return Line{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Line{}, writeError("创建会计凭证行失败", err)
	}
	return item, nil
}

func (s *Service) UpdateLine(ctx context.Context, actor *authz.Actor, id uuid.UUID, input UpdateLineInput) (Line, error) {
	if err := require(actor, "update"); err != nil {
		return Line{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Line{}, apierror.Wrap(apierror.CodeInternal, "更新会计凭证行失败", err)
	}
	defer tx.Rollback(ctx)
	q := dbgen.New(tx)
	current, err := q.GetGLJournalLine(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Line{}, lineNotFound()
	}
	if err != nil {
		return Line{}, apierror.Wrap(apierror.CodeInternal, "读取会计凭证行失败", err)
	}
	if !actor.CanAccessCompany(current.CompanyID) {
		return Line{}, lineNotFound()
	}
	journal, err := lockDraftJournal(ctx, q, actor, current.JournalID)
	if err != nil {
		return Line{}, err
	}
	locked, err := q.LockGLJournalLine(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Line{}, lineNotFound()
	}
	if err != nil {
		return Line{}, apierror.Wrap(apierror.CodeInternal, "锁定会计凭证行失败", err)
	}
	before := lineFromModel(locked)
	after := before
	if input.Idx != nil {
		after.Idx = *input.Idx
	}
	if input.AccountID != nil {
		after.AccountID = *input.AccountID
	}
	if input.Debit != nil {
		after.Debit = *input.Debit
	}
	if input.Credit != nil {
		after.Credit = *input.Credit
	}
	if input.PartyType != nil {
		after.PartyType = *input.PartyType
	}
	if input.PartyID != nil {
		after.PartyID = *input.PartyID
	}
	if input.Remarks != nil {
		after.Remarks = *input.Remarks
	}
	if err := validateLineShape(after.Idx, after.AccountID, after.Debit, after.Credit, after.PartyType, after.PartyID, after.Remarks); err != nil {
		return Line{}, err
	}
	currencyID, err := validateLineReferences(ctx, q, journal.CompanyID, after.AccountID, after.PartyType, after.PartyID)
	if err != nil {
		return Line{}, err
	}
	after.CurrencyID = currencyID
	changes := audit.Diff(lineSnapshot(before), lineSnapshot(after), lineAuditFields)
	if len(changes) == 0 {
		projected := lineFromRow(current)
		if err := tx.Commit(ctx); err != nil {
			return Line{}, writeError("更新会计凭证行失败", err)
		}
		return projected, nil
	}
	if _, err := q.UpdateGLJournalLine(ctx, dbgen.UpdateGLJournalLineParams{
		ID: id, Idx: after.Idx, Debit: after.Debit, Credit: after.Credit,
		PartyType: dbPartyText(after.PartyType), PartyID: after.PartyID,
		Remarks: text(after.Remarks), AccountID: after.AccountID, CurrencyID: currencyID,
	}); err != nil {
		return Line{}, writeError("更新会计凭证行失败", err)
	}
	projected, err := q.GetGLJournalLine(ctx, id)
	if err != nil {
		return Line{}, apierror.Wrap(apierror.CodeInternal, "读取更新后会计凭证行失败", err)
	}
	item := lineFromRow(projected)
	if err := writeLineAudit(ctx, tx, actor, item, "update", "update", changes); err != nil {
		return Line{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Line{}, writeError("更新会计凭证行失败", err)
	}
	return item, nil
}

func (s *Service) DeleteLine(ctx context.Context, actor *authz.Actor, id uuid.UUID) error {
	if err := require(actor, "delete"); err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除会计凭证行失败", err)
	}
	defer tx.Rollback(ctx)
	q := dbgen.New(tx)
	current, err := q.GetGLJournalLine(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return lineNotFound()
	}
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "读取会计凭证行失败", err)
	}
	if !actor.CanAccessCompany(current.CompanyID) {
		return lineNotFound()
	}
	if _, err := lockDraftJournal(ctx, q, actor, current.JournalID); err != nil {
		return err
	}
	locked, err := q.LockGLJournalLine(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return lineNotFound()
	}
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "锁定会计凭证行失败", err)
	}
	item := lineFromModel(locked)
	if _, err := q.DeleteGLJournalLine(ctx, id); err != nil {
		return writeError("删除会计凭证行失败", err)
	}
	if err := writeLineAudit(ctx, tx, actor, item, "destroy", "destroy",
		audit.Destroyed(lineSnapshot(item), lineAuditFields)); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return writeError("删除会计凭证行失败", err)
	}
	return nil
}

func lockDraftJournal(ctx context.Context, q *dbgen.Queries, actor *authz.Actor, journalID uuid.UUID) (dbgen.AccGlJournal, error) {
	row, err := q.LockGLJournal(ctx, journalID)
	if errors.Is(err, pgx.ErrNoRows) {
		return dbgen.AccGlJournal{}, notFound()
	}
	if err != nil {
		return dbgen.AccGlJournal{}, apierror.Wrap(apierror.CodeInternal, "锁定会计凭证失败", err)
	}
	if !actor.CanAccessCompany(row.CompanyID) {
		return dbgen.AccGlJournal{}, notFound()
	}
	if row.Status != "draft" {
		return dbgen.AccGlJournal{}, apierror.New(apierror.CodeConflict, "仅草稿凭证可编辑分录行")
	}
	return row, nil
}

func validateLineShape(idx int64, accountID uuid.UUID, debit, credit decimal.Decimal, partyType *string, partyID *uuid.UUID, remarks *string) error {
	fields := map[string][]string{}
	if accountID == uuid.Nil {
		fields["accountId"] = []string{"必填"}
	}
	if debit.IsNegative() || credit.IsNegative() || (debit.IsPositive() && credit.IsPositive()) {
		fields["amount"] = []string{"借贷金额不得为负且至多一边大于零"}
	}
	if (partyType == nil) != (partyID == nil) {
		fields["partyId"] = []string{"对手类型与对手必须同时填写"}
	}
	if partyType != nil {
		normalized := strings.ToLower(strings.TrimSpace(*partyType))
		if normalized != "supplier" && normalized != "customer" &&
			normalized != "company" && normalized != "employee" {
			fields["partyType"] = []string{"只能为 SUPPLIER、CUSTOMER、COMPANY 或 EMPLOYEE"}
		}
	}
	if remarks != nil && utf8.RuneCountInString(*remarks) > 512 {
		fields["remarks"] = []string{"最多 512 个字符"}
	}
	if len(fields) > 0 {
		return apierror.Validation("会计凭证行参数不合法", fields)
	}
	return nil
}

func validateLineReferences(ctx context.Context, q *dbgen.Queries, companyID, accountID uuid.UUID, partyType *string, partyID *uuid.UUID) (*uuid.UUID, error) {
	account, err := q.GetGLJournalLineAccount(ctx, accountID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, validation("accountId", "科目不存在")
	}
	if err != nil {
		return nil, apierror.Wrap(apierror.CodeInternal, "读取会计科目失败", err)
	}
	switch {
	case account.CompanyID != companyID:
		return nil, validation("accountId", "科目必须属于凭证所在公司")
	case account.IsGroup:
		return nil, validation("accountId", "汇总科目不能入账")
	case !account.Active:
		return nil, validation("accountId", "停用科目不能入账")
	}
	if partyType != nil && partyID != nil {
		exists, err := q.GLJournalPartyExists(ctx, dbgen.GLJournalPartyExistsParams{
			PartyType: strings.ToLower(strings.TrimSpace(*partyType)), PartyID: *partyID,
		})
		if err != nil {
			return nil, apierror.Wrap(apierror.CodeInternal, "校验会计凭证对手失败", err)
		}
		if !exists {
			return nil, validation("partyId", "对手不存在")
		}
	}
	return account.CurrencyID, nil
}

func validatePersistedLine(ctx context.Context, q *dbgen.Queries, companyID uuid.UUID, line Line) error {
	if err := validateLineShape(line.Idx, line.AccountID, line.Debit, line.Credit, line.PartyType, line.PartyID, line.Remarks); err != nil {
		return err
	}
	currency, err := validateLineReferences(ctx, q, companyID, line.AccountID, line.PartyType, line.PartyID)
	if err != nil {
		return err
	}
	if (currency == nil) != (line.CurrencyID == nil) ||
		(currency != nil && line.CurrencyID != nil && *currency != *line.CurrencyID) {
		return validation("currencyId", "行币种与科目币种不一致")
	}
	return nil
}

func writeLineAudit(ctx context.Context, tx pgx.Tx, actor *authz.Actor, item Line, actionType, actionName string, changes map[string]audit.Change) error {
	if err := audit.Write(ctx, tx, actor, audit.Entry{
		Resource: "acc_gl_journal_line", RecordID: item.ID,
		RecordLabel: fmt.Sprintf("%d", item.Idx), ActionType: actionType,
		ActionName: actionName, CompanyID: &item.CompanyID, Changes: changes,
	}); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "写入会计凭证行审计失败", err)
	}
	return nil
}

var lineAuditFields = []string{
	"idx", "debit", "credit", "party_type", "party_id", "remarks",
	"journal_id", "company_id", "account_id", "currency_id",
}

func lineSnapshot(item Line) map[string]any {
	return map[string]any{
		"idx": item.Idx, "debit": item.Debit, "credit": item.Credit,
		"party_type": item.PartyType, "party_id": item.PartyID, "remarks": item.Remarks,
		"journal_id": item.JournalID, "company_id": item.CompanyID,
		"account_id": item.AccountID, "currency_id": item.CurrencyID,
	}
}

func lineNotFound() error {
	return apierror.New(apierror.CodeNotFound, "会计凭证行不存在")
}

func dbPartyText(value *string) pgtype.Text {
	if value == nil {
		return pgtype.Text{}
	}
	return pgtype.Text{String: strings.ToLower(strings.TrimSpace(*value)), Valid: true}
}

func scanLine(row scanner) (Line, error) {
	var raw dbgen.GetGLJournalLineRow
	err := row.Scan(
		&raw.ID, &raw.Idx, &raw.Debit, &raw.Credit, &raw.PartyType,
		&raw.PartyID, &raw.Remarks, &raw.InsertedAt, &raw.UpdatedAt,
		&raw.JournalID, &raw.CompanyID, &raw.AccountID, &raw.CurrencyID,
		&raw.VoucherNo, &raw.CompanyName, &raw.AccountCode, &raw.AccountName,
		&raw.CurrencyCode, &raw.CurrencyName,
	)
	return lineFromRow(raw), err
}

func lineFromRow(row dbgen.GetGLJournalLineRow) Line {
	item := Line{
		ID: row.ID, Idx: row.Idx, Debit: row.Debit, Credit: row.Credit,
		PartyType: upperOptionalText(row.PartyType), PartyID: row.PartyID,
		Remarks: optionalText(row.Remarks), InsertedAt: row.InsertedAt.Time.UTC(),
		UpdatedAt: row.UpdatedAt.Time.UTC(), JournalID: row.JournalID,
		CompanyID: row.CompanyID, AccountID: row.AccountID, CurrencyID: row.CurrencyID,
		Journal: JournalRef{ID: row.JournalID, VoucherNo: row.VoucherNo},
		Company: NamedRef{ID: row.CompanyID, Name: row.CompanyName},
		Account: CodeNamedRef{ID: row.AccountID, Code: row.AccountCode, Name: row.AccountName},
	}
	if row.CurrencyID != nil {
		item.Currency = &CodeNamedRef{
			ID: *row.CurrencyID, Code: row.CurrencyCode.String, Name: row.CurrencyName.String,
		}
	}
	return item
}

func lineFromListRow(row dbgen.ListGLJournalLinesByJournalRow) Line {
	return lineFromRow(dbgen.GetGLJournalLineRow{
		ID: row.ID, Idx: row.Idx, Debit: row.Debit, Credit: row.Credit,
		PartyType: row.PartyType, PartyID: row.PartyID, Remarks: row.Remarks,
		InsertedAt: row.InsertedAt, UpdatedAt: row.UpdatedAt,
		JournalID: row.JournalID, CompanyID: row.CompanyID, AccountID: row.AccountID,
		CurrencyID: row.CurrencyID, VoucherNo: row.VoucherNo, CompanyName: row.CompanyName,
		AccountCode: row.AccountCode, AccountName: row.AccountName,
		CurrencyCode: row.CurrencyCode, CurrencyName: row.CurrencyName,
	})
}

func lineFromModel(row dbgen.AccGlJournalLine) Line {
	return Line{
		ID: row.ID, Idx: row.Idx, Debit: row.Debit, Credit: row.Credit,
		PartyType: upperOptionalText(row.PartyType), PartyID: row.PartyID,
		Remarks: optionalText(row.Remarks), InsertedAt: row.InsertedAt.Time.UTC(),
		UpdatedAt: row.UpdatedAt.Time.UTC(), JournalID: row.JournalID,
		CompanyID: row.CompanyID, AccountID: row.AccountID, CurrencyID: row.CurrencyID,
	}
}

func upperOptionalText(value pgtype.Text) *string {
	if !value.Valid {
		return nil
	}
	result := strings.ToUpper(value.String)
	return &result
}
