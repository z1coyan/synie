package printing

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/z1coyan/synie/server/internal/db/dbgen"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/audit"
	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/platform/files"
)

const permissionPrefix = "sys.print_template"

var templateAuditFields = []string{"name", "resource", "is_default", "remarks", "file_id"}

type Service struct {
	pool      *pgxpool.Pool
	files     StoredFileReader
	catalog   *FieldCatalog
	builders  map[string]DocBuilder
	converter PDFConverter
}

func NewService(pool *pgxpool.Pool, fileReader StoredFileReader, catalog *FieldCatalog) *Service {
	if catalog == nil {
		panic("打印服务需要字段目录（由 meta.Registry 派生）")
	}
	service := &Service{pool: pool, files: fileReader, catalog: catalog}
	if pool != nil {
		service.builders = map[string]DocBuilder{
			"sales.order": newSalesOrderDocBuilder(pool),
		}
	} else {
		service.builders = map[string]DocBuilder{}
	}
	return service
}

func (s *Service) Catalog() *FieldCatalog { return s.catalog }

func (s *Service) Get(ctx context.Context, id uuid.UUID) (Template, error) {
	value, err := scanTemplate(s.pool.QueryRow(ctx, templateSelect+" WHERE id=$1", id))
	if errors.Is(err, pgx.ErrNoRows) {
		return Template{}, apierror.New(apierror.CodeNotFound, "打印模板不存在")
	}
	if err != nil {
		return Template{}, apierror.Wrap(apierror.CodeInternal, "读取打印模板失败", err)
	}
	return value, nil
}

func (s *Service) List(ctx context.Context, query ListQuery) (TemplateList, error) {
	if query.Limit == 0 {
		query.Limit = 20
	}
	if query.Limit < 1 || query.Limit > 200 || query.Offset < 0 {
		return TemplateList{}, apierror.Validation("分页参数不合法", map[string][]string{"limit": {"必须在 1 到 200 之间"}})
	}
	built, err := filterbuild.Build(ResourceMeta(), filterbuild.Query{
		Limit: query.Limit, Offset: query.Offset, Search: query.Search,
		Sort: query.Sort, Filter: query.Filter,
	})
	if err != nil {
		return TemplateList{}, err
	}
	order := built.OrderBy
	if order == "" {
		order = ` ORDER BY "inserted_at" DESC, "id"`
	} else {
		order += `, "id"`
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return TemplateList{}, apierror.Wrap(apierror.CodeInternal, "查询打印模板失败", err)
	}
	defer tx.Rollback(ctx)
	var result TemplateList
	if err := tx.QueryRow(ctx, "SELECT count(*) FROM sys_print_template"+built.Where, built.Args...).Scan(&result.Count); err != nil {
		return result, apierror.Wrap(apierror.CodeInternal, "统计打印模板失败", err)
	}
	args := append([]any(nil), built.Args...)
	index := len(args) + 1
	args = append(args, query.Limit, query.Offset)
	rows, err := tx.Query(ctx, templateSelect+built.Where+order+
		fmt.Sprintf(" LIMIT $%d OFFSET $%d", index, index+1), args...)
	if err != nil {
		return result, apierror.Wrap(apierror.CodeInternal, "查询打印模板失败", err)
	}
	defer rows.Close()
	result.Results = make([]Template, 0, query.Limit)
	for rows.Next() {
		value, scanErr := scanTemplate(rows)
		if scanErr != nil {
			return result, apierror.Wrap(apierror.CodeInternal, "读取打印模板结果失败", scanErr)
		}
		result.Results = append(result.Results, value)
	}
	if err := rows.Err(); err != nil {
		return result, apierror.Wrap(apierror.CodeInternal, "遍历打印模板结果失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return result, apierror.Wrap(apierror.CodeInternal, "完成打印模板查询失败", err)
	}
	return result, nil
}

func (s *Service) ListUsable(ctx context.Context, actor *authz.Actor, resource string) ([]Template, error) {
	if _, ok := s.catalog.Get(resource); !ok {
		return nil, apierror.Validation("不支持的资源类型 "+resource, map[string][]string{"resource": {"不在打印字段目录中"}})
	}
	if !CanUseTemplates(actor, resource) {
		return nil, apierror.New(apierror.CodeForbidden, "无权使用该资源的打印模板")
	}
	rows, err := s.pool.Query(ctx, templateSelect+`
		WHERE resource=$1 ORDER BY is_default DESC,name,id
	`, resource)
	if err != nil {
		return nil, apierror.Wrap(apierror.CodeInternal, "查询可用打印模板失败", err)
	}
	defer rows.Close()
	result := make([]Template, 0)
	for rows.Next() {
		value, scanErr := scanTemplate(rows)
		if scanErr != nil {
			return nil, apierror.Wrap(apierror.CodeInternal, "读取可用打印模板失败", scanErr)
		}
		result = append(result, value)
	}
	if err := rows.Err(); err != nil {
		return nil, apierror.Wrap(apierror.CodeInternal, "遍历可用打印模板失败", err)
	}
	return result, nil
}

func CanUseTemplates(actor *authz.Actor, resource string) bool {
	if actor == nil {
		return false
	}
	if actor.HasPermission(permissionPrefix + ":read") {
		return true
	}
	for _, action := range []string{"print", "export", "batch_print"} {
		if actor.HasPermission(resource + ":" + action) {
			return true
		}
	}
	return false
}

func (s *Service) Create(ctx context.Context, actor *authz.Actor, input CreateInput) (Template, error) {
	input.Name = strings.TrimSpace(input.Name)
	if err := s.validateTemplateFile(ctx, input.Name, input.Resource, input.FileID); err != nil {
		return Template{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Template{}, apierror.Wrap(apierror.CodeInternal, "创建打印模板失败", err)
	}
	defer tx.Rollback(ctx)
	value, err := scanTemplate(tx.QueryRow(ctx, `
		INSERT INTO sys_print_template (name,resource,file_id,remarks)
		VALUES ($1,$2,$3,$4)
		RETURNING id,name,resource,is_default,remarks,file_id,inserted_at,updated_at
	`, input.Name, input.Resource, input.FileID, input.Remarks))
	if err != nil {
		return Template{}, templateWriteError("创建打印模板失败", err)
	}
	if err := syncAttachment(ctx, tx, value.ID, value.FileID); err != nil {
		return Template{}, apierror.Wrap(apierror.CodeInternal, "创建打印模板失败", err)
	}
	if err := writeTemplateAudit(ctx, tx, actor, value, "create", "create",
		audit.Created(templateSnapshot(value), templateAuditFields)); err != nil {
		return Template{}, apierror.Wrap(apierror.CodeInternal, "创建打印模板失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return Template{}, templateWriteError("创建打印模板失败", err)
	}
	return value, nil
}

func (s *Service) Update(ctx context.Context, actor *authz.Actor, id uuid.UUID, input UpdateInput) (Template, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Template{}, apierror.Wrap(apierror.CodeInternal, "更新打印模板失败", err)
	}
	defer tx.Rollback(ctx)
	before, err := lockTemplate(ctx, tx, id)
	if err != nil {
		return Template{}, err
	}
	after := before
	if input.Name != nil {
		after.Name = strings.TrimSpace(*input.Name)
	}
	if input.FileID != nil {
		after.FileID = *input.FileID
	}
	if input.Remarks != nil {
		after.Remarks = *input.Remarks
	}
	if err := s.validateTemplateFile(ctx, after.Name, after.Resource, after.FileID); err != nil {
		return Template{}, err
	}
	changes := audit.Diff(templateSnapshot(before), templateSnapshot(after), templateAuditFields)
	if len(changes) == 0 {
		if err := tx.Commit(ctx); err != nil {
			return Template{}, apierror.Wrap(apierror.CodeInternal, "更新打印模板失败", err)
		}
		return before, nil
	}
	after, err = scanTemplate(tx.QueryRow(ctx, `
		UPDATE sys_print_template
		SET name=$2,file_id=$3,remarks=$4,updated_at=(now() AT TIME ZONE 'utc')
		WHERE id=$1
		RETURNING id,name,resource,is_default,remarks,file_id,inserted_at,updated_at
	`, id, after.Name, after.FileID, after.Remarks))
	if err != nil {
		return Template{}, templateWriteError("更新打印模板失败", err)
	}
	if before.FileID != after.FileID {
		if err := syncAttachment(ctx, tx, after.ID, after.FileID); err != nil {
			return Template{}, apierror.Wrap(apierror.CodeInternal, "更新打印模板失败", err)
		}
	}
	if err := writeTemplateAudit(ctx, tx, actor, after, "update", "update", changes); err != nil {
		return Template{}, apierror.Wrap(apierror.CodeInternal, "更新打印模板失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return Template{}, templateWriteError("更新打印模板失败", err)
	}
	return after, nil
}

func (s *Service) SetDefault(ctx context.Context, actor *authz.Actor, id uuid.UUID) (Template, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Template{}, apierror.Wrap(apierror.CodeInternal, "设置默认模板失败", err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtext('sys_print_template_default'))"); err != nil {
		return Template{}, apierror.Wrap(apierror.CodeInternal, "设置默认模板失败", err)
	}
	target, err := lockTemplate(ctx, tx, id)
	if err != nil {
		return Template{}, err
	}
	rows, err := tx.Query(ctx, `
		SELECT id,name,resource,is_default,remarks,file_id,inserted_at,updated_at
		FROM sys_print_template
		WHERE resource=$1 AND is_default=true AND id<>$2
		FOR UPDATE
	`, target.Resource, target.ID)
	if err != nil {
		return Template{}, apierror.Wrap(apierror.CodeInternal, "设置默认模板失败", err)
	}
	previous := make([]Template, 0)
	for rows.Next() {
		value, scanErr := scanTemplate(rows)
		if scanErr != nil {
			rows.Close()
			return Template{}, apierror.Wrap(apierror.CodeInternal, "设置默认模板失败", scanErr)
		}
		previous = append(previous, value)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return Template{}, apierror.Wrap(apierror.CodeInternal, "设置默认模板失败", err)
	}
	for _, value := range previous {
		if _, err := tx.Exec(ctx, `
			UPDATE sys_print_template
			SET is_default=false,updated_at=(now() AT TIME ZONE 'utc') WHERE id=$1
		`, value.ID); err != nil {
			return Template{}, templateWriteError("设置默认模板失败", err)
		}
		after := value
		after.IsDefault = false
		if err := writeTemplateAudit(ctx, tx, actor, after, "update", "unset_default",
			audit.Diff(templateSnapshot(value), templateSnapshot(after), templateAuditFields)); err != nil {
			return Template{}, apierror.Wrap(apierror.CodeInternal, "设置默认模板失败", err)
		}
	}
	if !target.IsDefault {
		before := target
		target, err = scanTemplate(tx.QueryRow(ctx, `
			UPDATE sys_print_template
			SET is_default=true,updated_at=(now() AT TIME ZONE 'utc')
			WHERE id=$1
			RETURNING id,name,resource,is_default,remarks,file_id,inserted_at,updated_at
		`, target.ID))
		if err != nil {
			return Template{}, templateWriteError("设置默认模板失败", err)
		}
		if err := writeTemplateAudit(ctx, tx, actor, target, "update", "set_default",
			audit.Diff(templateSnapshot(before), templateSnapshot(target), templateAuditFields)); err != nil {
			return Template{}, apierror.Wrap(apierror.CodeInternal, "设置默认模板失败", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return Template{}, templateWriteError("设置默认模板失败", err)
	}
	return target, nil
}

func (s *Service) UnsetDefault(ctx context.Context, actor *authz.Actor, id uuid.UUID) (Template, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Template{}, apierror.Wrap(apierror.CodeInternal, "取消默认模板失败", err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtext('sys_print_template_default'))"); err != nil {
		return Template{}, apierror.Wrap(apierror.CodeInternal, "取消默认模板失败", err)
	}
	before, err := lockTemplate(ctx, tx, id)
	if err != nil {
		return Template{}, err
	}
	if !before.IsDefault {
		if err := tx.Commit(ctx); err != nil {
			return Template{}, apierror.Wrap(apierror.CodeInternal, "取消默认模板失败", err)
		}
		return before, nil
	}
	after, err := scanTemplate(tx.QueryRow(ctx, `
		UPDATE sys_print_template
		SET is_default=false,updated_at=(now() AT TIME ZONE 'utc')
		WHERE id=$1
		RETURNING id,name,resource,is_default,remarks,file_id,inserted_at,updated_at
	`, id))
	if err != nil {
		return Template{}, templateWriteError("取消默认模板失败", err)
	}
	if err := writeTemplateAudit(ctx, tx, actor, after, "update", "unset_default",
		audit.Diff(templateSnapshot(before), templateSnapshot(after), templateAuditFields)); err != nil {
		return Template{}, apierror.Wrap(apierror.CodeInternal, "取消默认模板失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return Template{}, templateWriteError("取消默认模板失败", err)
	}
	return after, nil
}

func (s *Service) Delete(ctx context.Context, actor *authz.Actor, id uuid.UUID) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除打印模板失败", err)
	}
	defer tx.Rollback(ctx)
	value, err := lockTemplate(ctx, tx, id)
	if err != nil {
		return err
	}
	if err := dbgen.New(tx).DeletePrintTemplateAttachments(ctx, id); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除打印模板失败", err)
	}
	if _, err := tx.Exec(ctx, "DELETE FROM sys_print_template WHERE id=$1", id); err != nil {
		return templateWriteError("删除打印模板失败", err)
	}
	if err := writeTemplateAudit(ctx, tx, actor, value, "destroy", "destroy",
		audit.Destroyed(templateSnapshot(value), templateAuditFields)); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除打印模板失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return templateWriteError("删除打印模板失败", err)
	}
	return nil
}

func (s *Service) validateTemplateFile(ctx context.Context, name, resource string, fileID uuid.UUID) error {
	if name == "" {
		return apierror.Validation("模板名称不能为空", map[string][]string{"name": {"不能为空"}})
	}
	if utf8.RuneCountInString(name) > 64 {
		return apierror.Validation("模板名称最多 64 个字符", map[string][]string{"name": {"最多 64 个字符"}})
	}
	if _, ok := s.catalog.Get(resource); !ok {
		return apierror.Validation("不支持的资源类型 "+resource, map[string][]string{"resource": {"不在打印字段目录中"}})
	}
	if fileID == uuid.Nil {
		return apierror.Validation("请上传模板文件", map[string][]string{"fileId": {"不能为空"}})
	}
	if s.files == nil {
		return apierror.New(apierror.CodeInternal, "文件读取服务未初始化")
	}
	file, raw, err := s.files.ReadStoredFile(ctx, fileID)
	if err != nil {
		var appErr *apierror.Error
		if errors.As(err, &appErr) && appErr.Code == apierror.CodeNotFound {
			return apierror.Validation("模板文件不存在", map[string][]string{"fileId": {"模板文件不存在"}})
		}
		return apierror.Validation("无法读取模板文件", map[string][]string{"fileId": {"无法读取模板文件"}})
	}
	if !strings.HasSuffix(strings.ToLower(file.Filename), ".xlsx") {
		return apierror.Validation("只接受 .xlsx 模板文件", map[string][]string{"fileId": {"只接受 .xlsx 模板文件"}})
	}
	placeholders, err := ExtractPlaceholders(raw)
	if err != nil {
		return apierror.Validation(err.Error(), map[string][]string{"fileId": {err.Error()}})
	}
	return s.catalog.ValidatePlaceholders(resource, placeholders)
}

const templateSelect = `
	SELECT id,name,resource,is_default,remarks,file_id,inserted_at,updated_at
	FROM sys_print_template`

type templateScanner interface{ Scan(...any) error }

func scanTemplate(row templateScanner) (Template, error) {
	var value Template
	err := row.Scan(
		&value.ID, &value.Name, &value.Resource, &value.IsDefault, &value.Remarks,
		&value.FileID, &value.InsertedAt, &value.UpdatedAt,
	)
	if err != nil {
		return Template{}, err
	}
	value.InsertedAt = value.InsertedAt.UTC()
	value.UpdatedAt = value.UpdatedAt.UTC()
	return value, nil
}

func lockTemplate(ctx context.Context, tx pgx.Tx, id uuid.UUID) (Template, error) {
	value, err := scanTemplate(tx.QueryRow(ctx, templateSelect+" WHERE id=$1 FOR UPDATE", id))
	if errors.Is(err, pgx.ErrNoRows) {
		return Template{}, apierror.New(apierror.CodeNotFound, "打印模板不存在")
	}
	if err != nil {
		return Template{}, apierror.Wrap(apierror.CodeInternal, "读取打印模板失败", err)
	}
	return value, nil
}

func syncAttachment(ctx context.Context, tx pgx.Tx, templateID, fileID uuid.UUID) error {
	return dbgen.New(tx).ReplacePrintTemplateAttachment(
		ctx,
		dbgen.ReplacePrintTemplateAttachmentParams{TemplateID: templateID, FileID: fileID},
	)
}

func templateSnapshot(value Template) map[string]any {
	return map[string]any{
		"name": value.Name, "resource": value.Resource, "is_default": value.IsDefault,
		"remarks": value.Remarks, "file_id": value.FileID,
	}
}

func writeTemplateAudit(
	ctx context.Context,
	tx pgx.Tx,
	actor *authz.Actor,
	value Template,
	actionType string,
	actionName string,
	changes map[string]audit.Change,
) error {
	if len(changes) == 0 {
		return nil
	}
	return audit.Write(ctx, tx, actor, audit.Entry{
		Resource: "sys_print_template", RecordID: value.ID, RecordLabel: value.Name,
		ActionType: actionType, ActionName: actionName, Changes: changes,
	})
}

func templateWriteError(message string, err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "23503":
			return apierror.Validation("模板文件不存在", map[string][]string{"fileId": {"模板文件不存在"}})
		case "23505":
			return apierror.New(apierror.CodeConflict, "同一资源只能有一个默认模板")
		}
	}
	return apierror.Wrap(apierror.CodeInternal, message, err)
}

var _ StoredFileReader = (*files.Service)(nil)
