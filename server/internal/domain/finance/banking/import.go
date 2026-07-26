package banking

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/audit"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

var bankImportAuditFields = []string{
	"status", "error", "imported_at", "company_id", "bank_account_id",
	"template_id", "file_id", "created_by_id", "imported_by_id",
}

var bankImportItemAuditFields = []string{
	"row_no", "occurred_at", "income", "expense", "balance",
	"counterparty_name", "counterparty_account", "summary", "note", "error",
	"import_id", "company_id", "transaction_id",
}

func (s *Service) GetBankImport(
	ctx context.Context, actor *authz.Actor, id uuid.UUID,
) (BankImport, error) {
	if err := require(actor, "acc.bank_transaction", "import"); err != nil {
		return BankImport{}, err
	}
	item, err := queryBankImport(ctx, s.pool, id, false)
	if errors.Is(err, pgx.ErrNoRows) {
		return BankImport{}, notFound("流水导入记录")
	}
	if err != nil {
		return BankImport{}, apierror.Wrap(apierror.CodeInternal, "读取流水导入记录失败", err)
	}
	if err := requireCompany(actor, item.CompanyID, "流水导入记录"); err != nil {
		return BankImport{}, err
	}
	return item, nil
}

func (s *Service) QueryBankImports(
	ctx context.Context, actor *authz.Actor, query ListQuery,
) (BankImportList, error) {
	if err := require(actor, "acc.bank_transaction", "import"); err != nil {
		return BankImportList{}, err
	}
	if err := validatePage(&query); err != nil {
		return BankImportList{}, err
	}
	built, err := buildFilter(BankImportResource, query)
	if err != nil {
		return BankImportList{}, err
	}
	where, args, possible := scopedWhere(actor, built.Where, built.Args, "company_id")
	if !possible {
		return BankImportList{Results: []BankImport{}}, nil
	}
	order := built.OrderBy
	if order == "" {
		order = ` ORDER BY "id"`
	} else {
		order += `, "id"`
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{
		IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return BankImportList{}, apierror.Wrap(apierror.CodeInternal, "查询流水导入记录失败", err)
	}
	defer tx.Rollback(ctx)
	var result BankImportList
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM acc_bank_import`+where, args...).
		Scan(&result.Count); err != nil {
		return result, apierror.Wrap(apierror.CodeInternal, "统计流水导入记录失败", err)
	}
	sql, listArgs := appendPage(`SELECT `+bankImportColumns+`
		FROM acc_bank_import`+where+order, append([]any(nil), args...), query)
	rows, err := tx.Query(ctx, sql, listArgs...)
	if err != nil {
		return result, apierror.Wrap(apierror.CodeInternal, "查询流水导入记录失败", err)
	}
	defer rows.Close()
	result.Results = make([]BankImport, 0, query.Limit)
	for rows.Next() {
		item, scanErr := scanBankImport(rows)
		if scanErr != nil {
			return result, apierror.Wrap(apierror.CodeInternal, "读取流水导入记录结果失败", scanErr)
		}
		result.Results = append(result.Results, item)
	}
	if err := rows.Err(); err != nil {
		return result, apierror.Wrap(apierror.CodeInternal, "遍历流水导入记录结果失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return result, apierror.Wrap(apierror.CodeInternal, "完成流水导入记录查询失败", err)
	}
	return result, nil
}

func (s *Service) CreateBankImport(
	ctx context.Context, actor *authz.Actor, input BankImportCreateInput,
) (BankImport, error) {
	if err := require(actor, "acc.bank_transaction", "import"); err != nil {
		return BankImport{}, err
	}
	if err := require(actor, "sys.file", "read"); err != nil {
		return BankImport{}, err
	}
	if actor == nil || !actor.CanAccessCompany(input.CompanyID) {
		return BankImport{}, apierror.New(apierror.CodeForbidden, "无权操作该公司数据")
	}
	if s.files == nil {
		return BankImport{}, apierror.New(apierror.CodeInternal, "文件读取服务未配置")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return BankImport{}, apierror.Wrap(apierror.CodeInternal, "创建流水导入记录失败", err)
	}
	defer tx.Rollback(ctx)
	if err := validateOwnBankAccount(
		ctx, tx, input.CompanyID, input.BankAccountID, true,
	); err != nil {
		return BankImport{}, err
	}
	template, err := queryTemplate(ctx, tx, input.TemplateID, false)
	if errors.Is(err, pgx.ErrNoRows) {
		return BankImport{}, validation("流水导入记录",
			map[string][]string{"templateId": {"导入模板不存在"}})
	}
	if err != nil {
		return BankImport{}, apierror.Wrap(apierror.CodeInternal, "读取流水导入模板失败", err)
	}
	if template.CompanyID != input.CompanyID || template.BankAccountID != input.BankAccountID {
		return BankImport{}, validation("流水导入记录",
			map[string][]string{"templateId": {"导入模板必须属于所选银行账户"}})
	}
	var fileSHA *string
	if err := tx.QueryRow(ctx, `SELECT sha256 FROM sys_file WHERE id=$1`,
		input.FileID).Scan(&fileSHA); errors.Is(err, pgx.ErrNoRows) {
		return BankImport{}, validation("流水导入记录",
			map[string][]string{"fileId": {"导入文件不存在或不可见"}})
	} else if err != nil {
		return BankImport{}, apierror.Wrap(apierror.CodeInternal, "读取导入文件元数据失败", err)
	}
	sha := ""
	if fileSHA != nil {
		sha = *fileSHA
	}
	if sha != "" {
		// The schema intentionally has no duplicate-content unique index. A
		// transaction-scoped advisory lock serializes the check-and-insert pair.
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(
			hashtextextended($1::text || ':' || $2, 0))`, input.BankAccountID, sha); err != nil {
			return BankImport{}, apierror.Wrap(apierror.CodeInternal, "锁定导入文件指纹失败", err)
		}
		var duplicate bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(
			SELECT 1 FROM acc_bank_import i
			JOIN sys_file f ON f.id=i.file_id
			WHERE i.bank_account_id=$1 AND i.status<>'failed' AND f.sha256=$2)`,
			input.BankAccountID, sha).Scan(&duplicate); err != nil {
			return BankImport{}, apierror.Wrap(apierror.CodeInternal, "检查重复导入文件失败", err)
		}
		if duplicate {
			return BankImport{}, validation("流水导入记录", map[string][]string{
				"fileId": {"该账户已存在相同文件的导入记录,如需重新导入请先删除原记录"},
			})
		}
	}
	file, content, readErr := s.files.ReadStoredFile(ctx, input.FileID)
	var (
		items    []BankImportItem
		parseErr error
	)
	if readErr != nil || file.ID != input.FileID {
		parseErr = errors.New("读取存储对象失败,请重新上传文件")
	} else {
		items, parseErr = parseBankImport(template, content, s.utcOffset)
	}
	status := "parsed"
	var parseMessage *string
	if parseErr != nil {
		status = "failed"
		message := truncateRunes(parseErr.Error(), 500)
		parseMessage = &message
		items = nil
	}
	id := uuid.New()
	_, err = tx.Exec(ctx, `INSERT INTO acc_bank_import(
		id,status,error,company_id,bank_account_id,template_id,file_id,created_by_id)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
		id, status, parseMessage, input.CompanyID, input.BankAccountID,
		input.TemplateID, input.FileID, actorID(actor))
	if err != nil {
		return BankImport{}, writeError("创建流水导入记录失败", err)
	}
	for _, parsed := range items {
		if _, err := createBankImportItemInTx(ctx, tx, actor, id, input.CompanyID, parsed); err != nil {
			return BankImport{}, err
		}
	}
	item, err := queryBankImport(ctx, tx, id, false)
	if err != nil {
		return BankImport{}, apierror.Wrap(apierror.CodeInternal, "读取新建流水导入记录失败", err)
	}
	if err := writeAudit(ctx, tx, actor, "acc_bank_import", id, importLabel(item),
		"create", "create", &item.CompanyID,
		audit.Created(bankImportSnapshot(item), bankImportAuditFields)); err != nil {
		return BankImport{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return BankImport{}, writeError("创建流水导入记录失败", err)
	}
	return item, nil
}

func (s *Service) ImportBankImport(
	ctx context.Context, actor *authz.Actor, id uuid.UUID,
) (BankImport, error) {
	if err := require(actor, "acc.bank_transaction", "import"); err != nil {
		return BankImport{}, err
	}
	if err := require(actor, "acc.bank_transaction", "create"); err != nil {
		return BankImport{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return BankImport{}, apierror.Wrap(apierror.CodeInternal, "执行流水导入失败", err)
	}
	defer tx.Rollback(ctx)
	before, err := queryBankImport(ctx, tx, id, true)
	if errors.Is(err, pgx.ErrNoRows) {
		return BankImport{}, notFound("流水导入记录")
	}
	if err != nil {
		return BankImport{}, apierror.Wrap(apierror.CodeInternal, "锁定流水导入记录失败", err)
	}
	if err := requireCompany(actor, before.CompanyID, "流水导入记录"); err != nil {
		return BankImport{}, err
	}
	if before.Status != ImportParsed {
		return BankImport{}, conflict("仅「已解析」状态的导入记录可执行导入")
	}
	rows, err := tx.Query(ctx, `SELECT `+bankImportItemColumns+`
		FROM acc_bank_import_item WHERE import_id=$1 ORDER BY row_no,id FOR UPDATE`, id)
	if err != nil {
		return BankImport{}, apierror.Wrap(apierror.CodeInternal, "锁定流水导入行失败", err)
	}
	items := make([]BankImportItem, 0)
	for rows.Next() {
		item, scanErr := scanBankImportItem(rows)
		if scanErr != nil {
			rows.Close()
			return BankImport{}, apierror.Wrap(apierror.CodeInternal, "读取流水导入行失败", scanErr)
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return BankImport{}, apierror.Wrap(apierror.CodeInternal, "遍历流水导入行失败", err)
	}
	rows.Close()
	if len(items) == 0 {
		return BankImport{}, validation("流水导入记录",
			map[string][]string{"items": {"没有可导入的行"}})
	}
	badRows := make([]string, 0, 5)
	errorCount := 0
	for _, item := range items {
		if item.Error != nil {
			errorCount++
			if len(badRows) < 5 {
				badRows = append(badRows, strconv.FormatInt(item.RowNo, 10))
			}
		}
	}
	if errorCount > 0 {
		suffix := ""
		if errorCount > 5 {
			suffix = " 等"
		}
		return BankImport{}, validation("流水导入记录", map[string][]string{
			"items": {fmt.Sprintf("存在 %d 行错误(第 %s 行%s),修正或删除后才能导入",
				errorCount, strings.Join(badRows, "、"), suffix)},
		})
	}
	for _, staged := range items {
		created, createErr := s.createBankTransactionInTx(ctx, tx, actor,
			BankTransactionCreateInput{
				OccurredAt: valueOrZero(staged.OccurredAt),
				Income:     staged.Income, Expense: staged.Expense, Balance: staged.Balance,
				CounterpartyName:    staged.CounterpartyName,
				CounterpartyAccount: staged.CounterpartyAccount,
				Summary:             staged.Summary, Note: staged.Note,
				CompanyID: before.CompanyID, BankAccountID: before.BankAccountID,
			}, true)
		if createErr != nil {
			return BankImport{}, apierror.Wrap(apierror.CodeValidation,
				fmt.Sprintf("第 %d 行导入失败", staged.RowNo), createErr)
		}
		if _, err := tx.Exec(ctx, `UPDATE acc_bank_import_item
			SET transaction_id=$2,updated_at=timezone('utc',now()) WHERE id=$1`,
			staged.ID, created.ID); err != nil {
			return BankImport{}, writeError("回填流水导入行失败", err)
		}
		linked := staged
		transactionID := created.ID
		linked.TransactionID = &transactionID
		if err := writeAudit(ctx, tx, actor, "acc_bank_import_item", staged.ID,
			importItemLabel(staged), "update", "link_transaction", &staged.CompanyID,
			audit.Diff(bankImportItemSnapshot(staged), bankImportItemSnapshot(linked),
				bankImportItemAuditFields)); err != nil {
			return BankImport{}, err
		}
	}
	now := time.Now().UTC()
	_, err = tx.Exec(ctx, `UPDATE acc_bank_import SET
		status='imported',imported_at=$2,imported_by_id=$3,
		updated_at=timezone('utc',now()) WHERE id=$1`, id, now, actorID(actor))
	if err != nil {
		return BankImport{}, writeError("更新流水导入状态失败", err)
	}
	after, err := queryBankImport(ctx, tx, id, false)
	if err != nil {
		return BankImport{}, apierror.Wrap(apierror.CodeInternal, "读取导入结果失败", err)
	}
	if err := writeAudit(ctx, tx, actor, "acc_bank_import", id, importLabel(after),
		"update", "import", &after.CompanyID,
		audit.Diff(bankImportSnapshot(before), bankImportSnapshot(after),
			bankImportAuditFields)); err != nil {
		return BankImport{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return BankImport{}, writeError("执行流水导入失败", err)
	}
	return after, nil
}

func (s *Service) DeleteBankImport(
	ctx context.Context, actor *authz.Actor, id uuid.UUID,
) error {
	if err := require(actor, "acc.bank_transaction", "import"); err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除流水导入记录失败", err)
	}
	defer tx.Rollback(ctx)
	item, err := queryBankImport(ctx, tx, id, true)
	if errors.Is(err, pgx.ErrNoRows) {
		return notFound("流水导入记录")
	}
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "锁定流水导入记录失败", err)
	}
	if err := requireCompany(actor, item.CompanyID, "流水导入记录"); err != nil {
		return err
	}
	if item.Status == ImportImported {
		return conflict("已导入的记录不可删除")
	}
	if _, err := tx.Exec(ctx, `DELETE FROM acc_bank_import WHERE id=$1`, id); err != nil {
		return writeError("删除流水导入记录失败", err)
	}
	if err := writeAudit(ctx, tx, actor, "acc_bank_import", id, importLabel(item),
		"destroy", "destroy", &item.CompanyID,
		audit.Destroyed(bankImportSnapshot(item), bankImportAuditFields)); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return writeError("删除流水导入记录失败", err)
	}
	return nil
}

const bankImportColumns = `id,status,error,imported_at,inserted_at,updated_at,
	company_id,bank_account_id,template_id,file_id,created_by_id,imported_by_id,
	(SELECT count(*) FROM acc_bank_import_item ii WHERE ii.import_id=acc_bank_import.id),
	(SELECT count(*) FROM acc_bank_import_item ii
	 WHERE ii.import_id=acc_bank_import.id AND ii.error IS NOT NULL)`

func queryBankImport(
	ctx context.Context, db interface {
		QueryRow(context.Context, string, ...any) pgx.Row
	}, id uuid.UUID, lock bool,
) (BankImport, error) {
	sql := `SELECT ` + bankImportColumns + ` FROM acc_bank_import WHERE id=$1`
	if lock {
		sql += ` FOR UPDATE`
	}
	return scanBankImport(db.QueryRow(ctx, sql, id))
}

func scanBankImport(row rowScanner) (BankImport, error) {
	var item BankImport
	var status string
	err := row.Scan(
		&item.ID, &status, &item.Error, &item.ImportedAt,
		&item.InsertedAt, &item.UpdatedAt, &item.CompanyID, &item.BankAccountID,
		&item.TemplateID, &item.FileID, &item.CreatedByID, &item.ImportedByID,
		&item.ItemCount, &item.ErrorCount,
	)
	item.Status = upper(status)
	item.InsertedAt = item.InsertedAt.UTC()
	item.UpdatedAt = item.UpdatedAt.UTC()
	if item.ImportedAt != nil {
		value := item.ImportedAt.UTC()
		item.ImportedAt = &value
	}
	return item, err
}

func importLabel(item BankImport) string {
	return item.ID.String()
}

func bankImportSnapshot(item BankImport) map[string]any {
	return map[string]any{
		"status": lower(item.Status), "error": item.Error, "imported_at": item.ImportedAt,
		"company_id": item.CompanyID, "bank_account_id": item.BankAccountID,
		"template_id": item.TemplateID, "file_id": item.FileID,
		"created_by_id": item.CreatedByID, "imported_by_id": item.ImportedByID,
	}
}

func truncateRunes(value string, max int) string {
	if utf8.RuneCountInString(value) <= max {
		return value
	}
	runes := []rune(value)
	return string(runes[:max])
}

func valueOrZero(value *time.Time) time.Time {
	if value == nil {
		return time.Time{}
	}
	return *value
}
