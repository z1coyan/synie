package banking

import (
	"context"
	"errors"
	"regexp"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/z1coyan/synie/server/internal/db/listexec"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/audit"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

var columnRE = regexp.MustCompile(`^[A-Z]{1,2}$`)

var templateAuditFields = []string{
	"name", "start_row", "datetime_col", "datetime_format", "date_col",
	"date_format", "time_col", "time_format", "income_col", "expense_col",
	"amount_col", "balance_col", "counterparty_name_col",
	"counterparty_account_col", "summary_col", "note_col", "company_id",
	"bank_account_id",
}

func (s *Service) GetBankImportTemplate(
	ctx context.Context, actor *authz.Actor, id uuid.UUID,
) (BankImportTemplate, error) {
	if err := require(actor, "acc.bank_import_template", "read"); err != nil {
		return BankImportTemplate{}, err
	}
	item, err := queryTemplate(ctx, s.pool, id, false)
	if errors.Is(err, pgx.ErrNoRows) {
		return BankImportTemplate{}, notFound("流水导入模板")
	}
	if err != nil {
		return BankImportTemplate{}, apierror.Wrap(apierror.CodeInternal, "读取流水导入模板失败", err)
	}
	if err := requireCompany(actor, item.CompanyID, "流水导入模板"); err != nil {
		return BankImportTemplate{}, err
	}
	return item, nil
}

func (s *Service) QueryBankImportTemplates(
	ctx context.Context, actor *authz.Actor, query ListQuery,
) (BankImportTemplateList, error) {
	if err := require(actor, "acc.bank_import_template", "read"); err != nil {
		return BankImportTemplateList{}, err
	}
	result, err := listexec.List(ctx, listexec.Spec[BankImportTemplate]{
		Pool: s.pool, Resource: BankImportTemplateResourceMeta(), Label: "流水导入模板", Actor: actor,
		Source:       ` FROM acc_bank_import_template`,
		Select:       `SELECT ` + templateColumns,
		DefaultOrder: ` ORDER BY "id"`,
		Tiebreaker:   `, "id"`,
		Scan: func(rows pgx.Rows) (BankImportTemplate, error) {
			return scanTemplate(rows)
		},
	}, listQuery(query))
	if err != nil {
		return BankImportTemplateList{}, err
	}
	return BankImportTemplateList{Count: result.Count, Results: result.Results}, nil
}

func (s *Service) CreateBankImportTemplate(
	ctx context.Context, actor *authz.Actor, input BankImportTemplateCreateInput,
) (BankImportTemplate, error) {
	if err := require(actor, "acc.bank_import_template", "create"); err != nil {
		return BankImportTemplate{}, err
	}
	if actor == nil || !actor.CanAccessCompany(input.CompanyID) {
		return BankImportTemplate{}, apierror.New(apierror.CodeForbidden, "无权操作该公司数据")
	}
	normalizeTemplateCreate(&input)
	if input.StartRow == 0 {
		input.StartRow = 2
	}
	if err := validateTemplate(input.Name, input.StartRow,
		input.DatetimeCol, input.DatetimeFormat, input.DateCol, input.DateFormat,
		input.TimeCol, input.TimeFormat, input.IncomeCol, input.ExpenseCol,
		input.AmountCol, templateColumnsSlice(input)); err != nil {
		return BankImportTemplate{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return BankImportTemplate{}, apierror.Wrap(apierror.CodeInternal, "创建流水导入模板失败", err)
	}
	defer tx.Rollback(ctx)
	if err := validateOwnBankAccount(ctx, tx, input.CompanyID, input.BankAccountID, false); err != nil {
		return BankImportTemplate{}, err
	}
	id := uuid.New()
	_, err = tx.Exec(ctx, `INSERT INTO acc_bank_import_template(
		id,name,start_row,datetime_col,datetime_format,date_col,date_format,time_col,
		time_format,income_col,expense_col,amount_col,balance_col,counterparty_name_col,
		counterparty_account_col,summary_col,note_col,company_id,bank_account_id)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
		id, input.Name, input.StartRow, input.DatetimeCol, lowerPtr(input.DatetimeFormat),
		input.DateCol, lowerPtr(input.DateFormat), input.TimeCol, lowerPtr(input.TimeFormat),
		input.IncomeCol, input.ExpenseCol, input.AmountCol, input.BalanceCol,
		input.CounterpartyNameCol, input.CounterpartyAccountCol, input.SummaryCol,
		input.NoteCol, input.CompanyID, input.BankAccountID)
	if err != nil {
		return BankImportTemplate{}, writeError("创建流水导入模板失败", err)
	}
	item, err := queryTemplate(ctx, tx, id, false)
	if err != nil {
		return BankImportTemplate{}, apierror.Wrap(apierror.CodeInternal, "读取新建流水导入模板失败", err)
	}
	if err := writeAudit(ctx, tx, actor, "acc_bank_import_template", id, item.Name,
		"create", "create", &item.CompanyID,
		audit.Created(templateSnapshot(item), templateAuditFields)); err != nil {
		return BankImportTemplate{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return BankImportTemplate{}, writeError("创建流水导入模板失败", err)
	}
	return item, nil
}

func (s *Service) UpdateBankImportTemplate(
	ctx context.Context, actor *authz.Actor, id uuid.UUID, input BankImportTemplateUpdateInput,
) (BankImportTemplate, error) {
	if err := require(actor, "acc.bank_import_template", "update"); err != nil {
		return BankImportTemplate{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return BankImportTemplate{}, apierror.Wrap(apierror.CodeInternal, "更新流水导入模板失败", err)
	}
	defer tx.Rollback(ctx)
	before, err := queryTemplate(ctx, tx, id, true)
	if errors.Is(err, pgx.ErrNoRows) {
		return BankImportTemplate{}, notFound("流水导入模板")
	}
	if err != nil {
		return BankImportTemplate{}, apierror.Wrap(apierror.CodeInternal, "锁定流水导入模板失败", err)
	}
	if err := requireCompany(actor, before.CompanyID, "流水导入模板"); err != nil {
		return BankImportTemplate{}, err
	}
	after := before
	applyTemplateUpdate(&after, input)
	normalizeTemplate(&after)
	if err := validateTemplate(after.Name, after.StartRow,
		after.DatetimeCol, after.DatetimeFormat, after.DateCol, after.DateFormat,
		after.TimeCol, after.TimeFormat, after.IncomeCol, after.ExpenseCol,
		after.AmountCol, templateRecordColumns(after)); err != nil {
		return BankImportTemplate{}, err
	}
	if err := validateOwnBankAccount(ctx, tx, after.CompanyID, after.BankAccountID, false); err != nil {
		return BankImportTemplate{}, err
	}
	changes := audit.Diff(templateSnapshot(before), templateSnapshot(after), templateAuditFields)
	if len(changes) == 0 {
		if err := tx.Commit(ctx); err != nil {
			return BankImportTemplate{}, writeError("更新流水导入模板失败", err)
		}
		return before, nil
	}
	_, err = tx.Exec(ctx, `UPDATE acc_bank_import_template SET
		name=$2,start_row=$3,datetime_col=$4,datetime_format=$5,date_col=$6,
		date_format=$7,time_col=$8,time_format=$9,income_col=$10,expense_col=$11,
		amount_col=$12,balance_col=$13,counterparty_name_col=$14,
		counterparty_account_col=$15,summary_col=$16,note_col=$17,bank_account_id=$18,
		updated_at=timezone('utc',now()) WHERE id=$1`,
		id, after.Name, after.StartRow, after.DatetimeCol, lowerPtr(after.DatetimeFormat),
		after.DateCol, lowerPtr(after.DateFormat), after.TimeCol, lowerPtr(after.TimeFormat),
		after.IncomeCol, after.ExpenseCol, after.AmountCol, after.BalanceCol,
		after.CounterpartyNameCol, after.CounterpartyAccountCol, after.SummaryCol,
		after.NoteCol, after.BankAccountID)
	if err != nil {
		return BankImportTemplate{}, writeError("更新流水导入模板失败", err)
	}
	item, err := queryTemplate(ctx, tx, id, false)
	if err != nil {
		return BankImportTemplate{}, apierror.Wrap(apierror.CodeInternal, "读取更新后流水导入模板失败", err)
	}
	if err := writeAudit(ctx, tx, actor, "acc_bank_import_template", id, item.Name,
		"update", "update", &item.CompanyID, changes); err != nil {
		return BankImportTemplate{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return BankImportTemplate{}, writeError("更新流水导入模板失败", err)
	}
	return item, nil
}

func (s *Service) DeleteBankImportTemplate(
	ctx context.Context, actor *authz.Actor, id uuid.UUID,
) error {
	if err := require(actor, "acc.bank_import_template", "delete"); err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除流水导入模板失败", err)
	}
	defer tx.Rollback(ctx)
	item, err := queryTemplate(ctx, tx, id, true)
	if errors.Is(err, pgx.ErrNoRows) {
		return notFound("流水导入模板")
	}
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "锁定流水导入模板失败", err)
	}
	if err := requireCompany(actor, item.CompanyID, "流水导入模板"); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM acc_bank_import_template WHERE id=$1`, id); err != nil {
		return writeError("删除流水导入模板失败", err)
	}
	if err := writeAudit(ctx, tx, actor, "acc_bank_import_template", id, item.Name,
		"destroy", "destroy", &item.CompanyID,
		audit.Destroyed(templateSnapshot(item), templateAuditFields)); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return writeError("删除流水导入模板失败", err)
	}
	return nil
}

func validateTemplate(
	name string, startRow int64, datetimeCol, datetimeFormat, dateCol, dateFormat,
	timeCol, timeFormat, incomeCol, expenseCol, amountCol *string, columns []*string,
) error {
	fields := map[string][]string{}
	validateRequiredText(fields, "name", name, 64)
	if startRow < 1 {
		fields["startRow"] = []string{"必须大于等于 1"}
	}
	for _, column := range columns {
		if column != nil && !columnRE.MatchString(*column) {
			fields["columns"] = []string{"列号须为 1-2 位字母(如 D、AA)"}
			break
		}
	}
	validateTemplateEnum(fields, "datetimeFormat", datetimeFormat, map[string]struct{}{
		"YMD_DASH_HMS": {}, "YMD_DASH_HM": {}, "YMD_SLASH_HMS": {},
		"YMD_SLASH_HM": {}, "COMPACT_SPACE": {}, "COMPACT": {},
		"ISO_T": {}, "CN_HMS": {}, "MDY_SLASH_HMS": {}, "DMY_SLASH_HMS": {},
	})
	validateTemplateEnum(fields, "dateFormat", dateFormat, map[string]struct{}{
		"YMD_DASH": {}, "YMD_SLASH": {}, "YMD_COMPACT": {}, "YMD_DOT": {},
		"YMD_CN": {}, "MDY_SLASH": {}, "DMY_SLASH": {}, "DMY_DASH": {},
	})
	validateTemplateEnum(fields, "timeFormat", timeFormat, map[string]struct{}{
		"HMS": {}, "HM": {}, "HMS_COMPACT": {}, "HMS_CN": {},
	})
	singleAny := datetimeCol != nil || datetimeFormat != nil
	doubleAny := dateCol != nil || dateFormat != nil || timeCol != nil || timeFormat != nil
	switch {
	case !singleAny && !doubleAny:
		fields["datetimeCol"] = []string{"必须配置日期时间列或日期列"}
	case singleAny && doubleAny:
		fields["datetimeCol"] = []string{"时间配置二选一:日期时间单列与日期/时间双列不可混填"}
	case singleAny && datetimeCol == nil:
		fields["datetimeCol"] = []string{"填了日期时间格式但缺日期时间列"}
	case singleAny && datetimeFormat == nil:
		fields["datetimeFormat"] = []string{"日期时间列必须选择格式"}
	case doubleAny && dateCol == nil:
		fields["dateCol"] = []string{"填了日期格式/时间列但缺日期列"}
	case doubleAny && dateFormat == nil:
		fields["dateFormat"] = []string{"日期列必须选择格式"}
	case timeCol != nil && timeFormat == nil:
		fields["timeFormat"] = []string{"时间列必须选择格式"}
	case timeCol == nil && timeFormat != nil:
		fields["timeCol"] = []string{"填了时间格式但缺时间列"}
	}
	switch {
	case amountCol != nil && (incomeCol != nil || expenseCol != nil):
		fields["amountCol"] = []string{"带符号金额列与收入/支出列不可同时配置"}
	case amountCol == nil && incomeCol == nil && expenseCol == nil:
		fields["incomeCol"] = []string{"必须配置收入/支出列或带符号金额列"}
	}
	if len(fields) > 0 {
		return validation("流水导入模板", fields)
	}
	return nil
}

func validateTemplateEnum(
	fields map[string][]string, field string, value *string, allowed map[string]struct{},
) {
	if value == nil {
		return
	}
	if _, ok := allowed[*value]; !ok {
		fields[field] = []string{"不是有效的格式"}
	}
}

func normalizeTemplateCreate(input *BankImportTemplateCreateInput) {
	input.Name = strings.TrimSpace(input.Name)
	for _, field := range templateColumnsSlice(*input) {
		normalizeColumn(field)
	}
	normalizeEnum(input.DatetimeFormat)
	normalizeEnum(input.DateFormat)
	normalizeEnum(input.TimeFormat)
}

func normalizeTemplate(item *BankImportTemplate) {
	item.Name = strings.TrimSpace(item.Name)
	for _, field := range templateRecordColumns(*item) {
		normalizeColumn(field)
	}
	normalizeEnum(item.DatetimeFormat)
	normalizeEnum(item.DateFormat)
	normalizeEnum(item.TimeFormat)
}

func normalizeColumn(value *string) {
	if value != nil {
		*value = upper(*value)
	}
}

func normalizeEnum(value *string) {
	if value != nil {
		*value = upper(*value)
	}
}

func lowerPtr(value *string) *string {
	if value == nil {
		return nil
	}
	result := lower(*value)
	return &result
}

func templateColumnsSlice(input BankImportTemplateCreateInput) []*string {
	return []*string{
		input.DatetimeCol, input.DateCol, input.TimeCol, input.IncomeCol, input.ExpenseCol,
		input.AmountCol, input.BalanceCol, input.CounterpartyNameCol,
		input.CounterpartyAccountCol, input.SummaryCol, input.NoteCol,
	}
}

func templateRecordColumns(item BankImportTemplate) []*string {
	return []*string{
		item.DatetimeCol, item.DateCol, item.TimeCol, item.IncomeCol, item.ExpenseCol,
		item.AmountCol, item.BalanceCol, item.CounterpartyNameCol,
		item.CounterpartyAccountCol, item.SummaryCol, item.NoteCol,
	}
}

func applyTemplateUpdate(item *BankImportTemplate, input BankImportTemplateUpdateInput) {
	if input.Name != nil {
		item.Name = *input.Name
	}
	if input.StartRow != nil {
		item.StartRow = *input.StartRow
	}
	applyOptional(&item.DatetimeCol, input.DatetimeCol)
	applyOptional(&item.DatetimeFormat, input.DatetimeFormat)
	applyOptional(&item.DateCol, input.DateCol)
	applyOptional(&item.DateFormat, input.DateFormat)
	applyOptional(&item.TimeCol, input.TimeCol)
	applyOptional(&item.TimeFormat, input.TimeFormat)
	applyOptional(&item.IncomeCol, input.IncomeCol)
	applyOptional(&item.ExpenseCol, input.ExpenseCol)
	applyOptional(&item.AmountCol, input.AmountCol)
	applyOptional(&item.BalanceCol, input.BalanceCol)
	applyOptional(&item.CounterpartyNameCol, input.CounterpartyNameCol)
	applyOptional(&item.CounterpartyAccountCol, input.CounterpartyAccountCol)
	applyOptional(&item.SummaryCol, input.SummaryCol)
	applyOptional(&item.NoteCol, input.NoteCol)
	if input.BankAccountID != nil {
		item.BankAccountID = *input.BankAccountID
	}
}

func applyOptional[T any](target **T, value Optional[T]) {
	if value.Set {
		*target = value.Value
	}
}

const templateColumns = `id,name,start_row,datetime_col,datetime_format,date_col,
	date_format,time_col,time_format,income_col,expense_col,amount_col,balance_col,
	counterparty_name_col,counterparty_account_col,summary_col,note_col,
	inserted_at,updated_at,company_id,bank_account_id`

func queryTemplate(
	ctx context.Context, db interface {
		QueryRow(context.Context, string, ...any) pgx.Row
	}, id uuid.UUID, lock bool,
) (BankImportTemplate, error) {
	sql := `SELECT ` + templateColumns + ` FROM acc_bank_import_template WHERE id=$1`
	if lock {
		sql += ` FOR UPDATE`
	}
	return scanTemplate(db.QueryRow(ctx, sql, id))
}

func scanTemplate(row rowScanner) (BankImportTemplate, error) {
	var item BankImportTemplate
	var datetimeFormat, dateFormat, timeFormat *string
	err := row.Scan(
		&item.ID, &item.Name, &item.StartRow, &item.DatetimeCol, &datetimeFormat,
		&item.DateCol, &dateFormat, &item.TimeCol, &timeFormat, &item.IncomeCol,
		&item.ExpenseCol, &item.AmountCol, &item.BalanceCol, &item.CounterpartyNameCol,
		&item.CounterpartyAccountCol, &item.SummaryCol, &item.NoteCol,
		&item.InsertedAt, &item.UpdatedAt, &item.CompanyID, &item.BankAccountID,
	)
	if datetimeFormat != nil {
		value := upper(*datetimeFormat)
		item.DatetimeFormat = &value
	}
	if dateFormat != nil {
		value := upper(*dateFormat)
		item.DateFormat = &value
	}
	if timeFormat != nil {
		value := upper(*timeFormat)
		item.TimeFormat = &value
	}
	item.InsertedAt = item.InsertedAt.UTC()
	item.UpdatedAt = item.UpdatedAt.UTC()
	return item, err
}

func templateSnapshot(item BankImportTemplate) map[string]any {
	return map[string]any{
		"name": item.Name, "start_row": item.StartRow,
		"datetime_col": item.DatetimeCol, "datetime_format": item.DatetimeFormat,
		"date_col": item.DateCol, "date_format": item.DateFormat,
		"time_col": item.TimeCol, "time_format": item.TimeFormat,
		"income_col": item.IncomeCol, "expense_col": item.ExpenseCol,
		"amount_col": item.AmountCol, "balance_col": item.BalanceCol,
		"counterparty_name_col":    item.CounterpartyNameCol,
		"counterparty_account_col": item.CounterpartyAccountCol,
		"summary_col":              item.SummaryCol, "note_col": item.NoteCol,
		"company_id": item.CompanyID, "bank_account_id": item.BankAccountID,
	}
}
