package files

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/audit"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

const maxUploadSize = int64(50 << 20)

var extensionPattern = regexp.MustCompile(`^\.[a-z0-9]{1,10}$`)

type Service struct{ pool *pgxpool.Pool }

func NewService(pool *pgxpool.Pool) *Service { return &Service{pool: pool} }

func (s *Service) Get(ctx context.Context, id uuid.UUID) (File, error) {
	var value File
	var size *int64
	var sha *string
	err := s.pool.QueryRow(ctx, `
		SELECT id, storage, key, filename, content_type, size, sha256, inserted_at, uploaded_by_id
		FROM sys_file WHERE id = $1
	`, id).Scan(
		&value.ID, &value.Storage, &value.Key, &value.Filename, &value.ContentType,
		&size, &sha, &value.InsertedAt, &value.UploadedByID,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return File{}, apierror.New(apierror.CodeNotFound, "文件不存在")
	}
	if err != nil {
		return File{}, apierror.Wrap(apierror.CodeInternal, "读取文件失败", err)
	}
	if size != nil {
		value.Size = *size
	}
	if sha != nil {
		value.SHA256 = *sha
	}
	value.InsertedAt = value.InsertedAt.UTC()
	return value, nil
}

// ReadStoredFile is the trusted cross-module seam for domain services that must
// validate stored file contents. Authorization remains the caller's concern.
func (s *Service) ReadStoredFile(ctx context.Context, id uuid.UUID) (File, []byte, error) {
	file, err := s.Get(ctx, id)
	if err != nil {
		return File{}, nil, err
	}
	endpoint, err := s.storageByName(ctx, file.Storage)
	if err != nil {
		return File{}, nil, err
	}
	store, err := endpoint.objectStorage()
	if err != nil {
		return File{}, nil, err
	}
	value, err := store.Read(ctx, file.Key)
	if errors.Is(err, ErrObjectNotFound) {
		return File{}, nil, apierror.New(apierror.CodeNotFound, "文件对象缺失")
	}
	if err != nil {
		return File{}, nil, apierror.Wrap(apierror.CodeInternal, "读取文件对象失败", err)
	}
	return file, value, nil
}

func (s *Service) List(ctx context.Context, query ListQuery) (FileList, error) {
	if query.Limit == 0 {
		query.Limit = 20
	}
	if query.Limit < 1 || query.Limit > 200 || query.Offset < 0 {
		return FileList{}, apierror.Validation("分页参数不合法", map[string][]string{"limit": {"必须在 1 到 200 之间"}})
	}
	built, err := filterbuild.Build(FileResourceMeta(), filterbuild.Query{
		Limit: query.Limit, Offset: query.Offset, Search: query.Search,
		Sort: query.Sort, Filter: query.Filter,
	})
	if err != nil {
		return FileList{}, err
	}
	order := built.OrderBy
	if order == "" {
		order = ` ORDER BY "inserted_at" DESC, "id"`
	} else {
		order += `, "id"`
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return FileList{}, apierror.Wrap(apierror.CodeInternal, "查询文件失败", err)
	}
	defer tx.Rollback(ctx)
	var result FileList
	if err = tx.QueryRow(ctx, "SELECT count(*) FROM sys_file"+built.Where, built.Args...).Scan(&result.Count); err != nil {
		return result, apierror.Wrap(apierror.CodeInternal, "统计文件失败", err)
	}
	args := append([]any(nil), built.Args...)
	n := len(args) + 1
	args = append(args, query.Limit, query.Offset)
	rows, err := tx.Query(ctx, `
		SELECT id, storage, key, filename, content_type, size, sha256, inserted_at, uploaded_by_id
		FROM sys_file`+built.Where+order+fmt.Sprintf(" LIMIT $%d OFFSET $%d", n, n+1), args...)
	if err != nil {
		return result, apierror.Wrap(apierror.CodeInternal, "查询文件失败", err)
	}
	defer rows.Close()
	result.Results = make([]File, 0, query.Limit)
	for rows.Next() {
		var value File
		var size *int64
		var sha *string
		if err = rows.Scan(
			&value.ID, &value.Storage, &value.Key, &value.Filename, &value.ContentType,
			&size, &sha, &value.InsertedAt, &value.UploadedByID,
		); err != nil {
			return result, apierror.Wrap(apierror.CodeInternal, "读取文件结果失败", err)
		}
		if size != nil {
			value.Size = *size
		}
		if sha != nil {
			value.SHA256 = *sha
		}
		value.InsertedAt = value.InsertedAt.UTC()
		result.Results = append(result.Results, value)
	}
	if err = rows.Err(); err != nil {
		return result, err
	}
	if err = tx.Commit(ctx); err != nil {
		return result, err
	}
	return result, nil
}

func (s *Service) Upload(ctx context.Context, actor *authz.Actor, input UploadInput) (UploadResult, error) {
	if actor == nil || !actor.HasPermission("sys.file:create") {
		return UploadResult{}, apierror.New(apierror.CodeForbidden, "无权限上传文件")
	}
	input.Filename = strings.TrimSpace(input.Filename)
	if input.Reader == nil || input.Filename == "" || len([]rune(input.Filename)) > 255 {
		return UploadResult{}, apierror.Validation("上传参数不合法", map[string][]string{"file": {"文件及文件名必填，文件名最多 255 个字符"}})
	}
	if (input.OwnerType == "") != (input.OwnerID == nil) {
		return UploadResult{}, apierror.Validation("附件宿主参数不完整", map[string][]string{"owner": {"ownerType 与 ownerId 必须同时提供"}})
	}

	temp, err := os.CreateTemp("", "synie-upload-*")
	if err != nil {
		return UploadResult{}, apierror.Wrap(apierror.CodeInternal, "创建上传临时文件失败", err)
	}
	tempPath := temp.Name()
	defer os.Remove(tempPath)
	hash := sha256.New()
	size, copyErr := io.Copy(io.MultiWriter(temp, hash), io.LimitReader(input.Reader, maxUploadSize+1))
	closeErr := temp.Close()
	if copyErr != nil || closeErr != nil {
		return UploadResult{}, apierror.Wrap(apierror.CodeInternal, "读取上传文件失败", errors.Join(copyErr, closeErr))
	}
	if size > maxUploadSize {
		return UploadResult{}, apierror.Validation("文件过大", map[string][]string{"file": {"单个文件不能超过 50MB"}})
	}

	endpoint, err := s.defaultStorage(ctx)
	if err != nil {
		return UploadResult{}, err
	}
	store, err := endpoint.objectStorage()
	if err != nil {
		return UploadResult{}, err
	}
	key := time.Now().UTC().Format("2006/01/02") + "/" + uuid.NewString() + safeExtension(input.Filename)
	if err = store.Put(ctx, key, tempPath); err != nil {
		return UploadResult{}, apierror.Wrap(apierror.CodeInternal, "写入文件存储失败", err)
	}
	cleanupObject := true
	defer func() {
		if cleanupObject {
			_ = store.Delete(context.Background(), key)
		}
	}()

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return UploadResult{}, apierror.Wrap(apierror.CodeInternal, "开始文件事务失败", err)
	}
	defer tx.Rollback(ctx)
	var companyID *uuid.UUID
	if input.OwnerID != nil {
		companyID, err = resolveOwner(ctx, tx, actor, input.OwnerType, *input.OwnerID)
		if err != nil {
			return UploadResult{}, err
		}
	}
	contentType := nullableString(input.ContentType)
	var result UploadResult
	err = tx.QueryRow(ctx, `
		INSERT INTO sys_file (storage, key, filename, content_type, size, sha256, uploaded_by_id)
		VALUES ($1,$2,$3,$4,$5,$6,$7)
		RETURNING id, storage, key, filename, content_type, size, sha256, inserted_at, uploaded_by_id
	`, endpoint.Name, key, input.Filename, contentType, size, hex.EncodeToString(hash.Sum(nil)), actor.UserID).Scan(
		&result.File.ID, &result.File.Storage, &result.File.Key, &result.File.Filename,
		&result.File.ContentType, &result.File.Size, &result.File.SHA256,
		&result.File.InsertedAt, &result.File.UploadedByID,
	)
	if err != nil {
		return UploadResult{}, apierror.Wrap(apierror.CodeInternal, "保存文件元数据失败", err)
	}
	result.File.InsertedAt = result.File.InsertedAt.UTC()
	if err = audit.Write(ctx, tx, actor, audit.Entry{
		Resource: "sys_file", RecordID: result.File.ID, RecordLabel: result.File.Filename,
		ActionType: "create", ActionName: "create", Changes: audit.Created(fileSnapshot(result.File), fileAuditFields),
	}); err != nil {
		return UploadResult{}, err
	}
	if input.OwnerID != nil {
		attachment, attachErr := createAttachment(ctx, tx, actor, result.File.ID, input.OwnerType, *input.OwnerID, input.Category, companyID)
		if attachErr != nil {
			return UploadResult{}, attachErr
		}
		result.Attachment = &attachment
	}
	if err = tx.Commit(ctx); err != nil {
		return UploadResult{}, apierror.Wrap(apierror.CodeInternal, "提交文件事务失败", err)
	}
	cleanupObject = false
	return result, nil
}

func (s *Service) Attach(ctx context.Context, actor *authz.Actor, fileID uuid.UUID, input AttachInput) (Attachment, error) {
	if actor == nil || !actor.HasPermission("sys.file:read") || !actor.HasPermission("sys.file:create") {
		return Attachment{}, apierror.New(apierror.CodeForbidden, "无权限挂接文件")
	}
	if input.OwnerType == "" || input.OwnerID == uuid.Nil {
		return Attachment{}, apierror.Validation("缺少附件宿主参数", map[string][]string{"owner": {"ownerType 与 ownerId 必填"}})
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Attachment{}, err
	}
	defer tx.Rollback(ctx)
	var uploaderID *uuid.UUID
	if err = tx.QueryRow(ctx, "SELECT uploaded_by_id FROM sys_file WHERE id=$1 FOR UPDATE", fileID).Scan(&uploaderID); errors.Is(err, pgx.ErrNoRows) {
		return Attachment{}, apierror.New(apierror.CodeNotFound, "文件不存在或无权访问")
	}
	if err != nil {
		return Attachment{}, apierror.Wrap(apierror.CodeInternal, "读取文件失败", err)
	}
	if !actor.SuperAdmin && (uploaderID == nil || *uploaderID != actor.UserID) {
		return Attachment{}, apierror.New(apierror.CodeForbidden, "仅能挂接本人上传的文件")
	}
	companyID, err := resolveOwner(ctx, tx, actor, input.OwnerType, input.OwnerID)
	if err != nil {
		return Attachment{}, err
	}
	attachment, err := createAttachment(ctx, tx, actor, fileID, input.OwnerType, input.OwnerID, input.Category, companyID)
	if err != nil {
		return Attachment{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Attachment{}, err
	}
	return attachment, nil
}

func createAttachment(
	ctx context.Context, tx pgx.Tx, actor *authz.Actor, fileID uuid.UUID,
	ownerType string, ownerID uuid.UUID, category string, companyID *uuid.UUID,
) (Attachment, error) {
	category = strings.TrimSpace(category)
	if category == "" {
		category = "default"
	}
	if len([]rune(category)) > 32 {
		return Attachment{}, apierror.Validation("附件分类不合法", map[string][]string{"category": {"最多 32 个字符"}})
	}
	var value Attachment
	err := tx.QueryRow(ctx, `
		INSERT INTO sys_attachment (file_id, owner_type, owner_id, category, company_id)
		VALUES ($1,$2,$3,$4,$5)
		RETURNING id, file_id, owner_type, owner_id, category, company_id, inserted_at
	`, fileID, ownerType, ownerID, category, companyID).Scan(
		&value.ID, &value.FileID, &value.OwnerType, &value.OwnerID,
		&value.Category, &value.CompanyID, &value.InsertedAt,
	)
	if err != nil {
		return Attachment{}, apierror.Wrap(apierror.CodeInternal, "创建附件挂接失败", err)
	}
	value.InsertedAt = value.InsertedAt.UTC()
	if err = audit.Write(ctx, tx, actor, audit.Entry{
		Resource: "sys_attachment", RecordID: value.ID, RecordLabel: value.OwnerType,
		ActionType: "create", ActionName: "create",
		Changes: audit.Created(attachmentSnapshot(value), attachmentAuditFields),
	}); err != nil {
		return Attachment{}, err
	}
	return value, nil
}

func (s *Service) ListAttachments(ctx context.Context, actor *authz.Actor, query AttachmentQuery) (AttachmentList, error) {
	if actor == nil || !actor.HasPermission("sys.file:read") {
		return AttachmentList{}, apierror.New(apierror.CodeForbidden, "无权限读取附件")
	}
	if query.Limit == 0 {
		query.Limit = 200
	}
	if query.Limit < 1 || query.Limit > 200 || query.Offset < 0 {
		return AttachmentList{}, apierror.Validation("分页参数不合法", map[string][]string{"limit": {"必须在 1 到 200 之间"}})
	}
	args := make([]any, 0, 8)
	where := []string{"1=1"}
	add := func(clause string, value any) {
		args = append(args, value)
		where = append(where, fmt.Sprintf(clause, len(args)))
	}
	if query.FileID != nil {
		add("a.file_id = $%d", *query.FileID)
	}
	if query.OwnerType != "" {
		add("a.owner_type = $%d", query.OwnerType)
	}
	if query.OwnerID != nil {
		add("a.owner_id = $%d", *query.OwnerID)
	}
	if query.Category != "" {
		add("a.category = $%d", query.Category)
	}
	if !actor.SuperAdmin && !actor.AllCompanies {
		args = append(args, actor.CompanyIDs)
		where = append(where, fmt.Sprintf("(a.company_id IS NULL OR a.company_id = ANY($%d))", len(args)))
	}
	base := " FROM sys_attachment a JOIN sys_file f ON f.id=a.file_id WHERE " + strings.Join(where, " AND ")
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return AttachmentList{}, err
	}
	defer tx.Rollback(ctx)
	var result AttachmentList
	if err = tx.QueryRow(ctx, "SELECT count(*)"+base, args...).Scan(&result.Count); err != nil {
		return result, apierror.Wrap(apierror.CodeInternal, "统计附件失败", err)
	}
	pageArgs := append([]any(nil), args...)
	n := len(pageArgs) + 1
	pageArgs = append(pageArgs, query.Limit, query.Offset)
	rows, err := tx.Query(ctx, `
		SELECT a.id,a.file_id,a.owner_type,a.owner_id,a.category,a.company_id,a.inserted_at,
		       f.id,f.storage,f.key,f.filename,f.content_type,f.size,f.sha256,f.inserted_at,f.uploaded_by_id
	`+base+fmt.Sprintf(" ORDER BY a.inserted_at,a.id LIMIT $%d OFFSET $%d", n, n+1), pageArgs...)
	if err != nil {
		return result, apierror.Wrap(apierror.CodeInternal, "查询附件失败", err)
	}
	defer rows.Close()
	result.Results = make([]Attachment, 0, query.Limit)
	for rows.Next() {
		var value Attachment
		var file File
		var size *int64
		var sha *string
		if err = rows.Scan(
			&value.ID, &value.FileID, &value.OwnerType, &value.OwnerID, &value.Category, &value.CompanyID, &value.InsertedAt,
			&file.ID, &file.Storage, &file.Key, &file.Filename, &file.ContentType, &size, &sha, &file.InsertedAt, &file.UploadedByID,
		); err != nil {
			return result, apierror.Wrap(apierror.CodeInternal, "读取附件结果失败", err)
		}
		if size != nil {
			file.Size = *size
		}
		if sha != nil {
			file.SHA256 = *sha
		}
		value.InsertedAt = value.InsertedAt.UTC()
		file.InsertedAt = file.InsertedAt.UTC()
		value.File = &file
		result.Results = append(result.Results, value)
	}
	if err = rows.Err(); err != nil {
		return result, err
	}
	if err = tx.Commit(ctx); err != nil {
		return result, err
	}
	return result, nil
}

func (s *Service) Download(ctx context.Context, actor *authz.Actor, id uuid.UUID) (Download, error) {
	if actor == nil || !actor.HasPermission("sys.file:read") {
		return Download{}, apierror.New(apierror.CodeForbidden, "无权限下载文件")
	}
	file, err := s.Get(ctx, id)
	if err != nil {
		return Download{}, err
	}
	rows, err := s.pool.Query(ctx, "SELECT owner_type,company_id FROM sys_attachment WHERE file_id=$1", id)
	if err != nil {
		return Download{}, apierror.Wrap(apierror.CodeInternal, "校验下载权限失败", err)
	}
	attached := false
	allowed := false
	for rows.Next() {
		attached = true
		var ownerType string
		var companyID *uuid.UUID
		if err = rows.Scan(&ownerType, &companyID); err != nil {
			rows.Close()
			return Download{}, err
		}
		spec, known := lookupOwner(ownerType)
		if !known || !actor.HasPermission(spec.PermissionPrefix+":read") {
			continue
		}
		if companyID == nil || actor.CanAccessCompany(*companyID) {
			allowed = true
		}
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return Download{}, err
	}
	if !attached {
		allowed = actor.SuperAdmin || (file.UploadedByID != nil && *file.UploadedByID == actor.UserID)
	}
	if !allowed {
		return Download{}, apierror.New(apierror.CodeForbidden, "无权下载该文件")
	}
	endpoint, err := s.storageByName(ctx, file.Storage)
	if err != nil {
		return Download{}, err
	}
	store, err := endpoint.objectStorage()
	if err != nil {
		return Download{}, err
	}
	if redirect, presignErr := store.PresignedGet(ctx, file.Key, 5*time.Minute); presignErr == nil {
		return Download{Filename: file.Filename, ContentType: contentType(file.ContentType), RedirectURL: redirect}, nil
	} else if !errors.Is(presignErr, errors.ErrUnsupported) {
		return Download{}, apierror.Wrap(apierror.CodeInternal, "生成文件下载地址失败", presignErr)
	}
	value, err := store.Read(ctx, file.Key)
	if errors.Is(err, ErrObjectNotFound) {
		return Download{}, apierror.New(apierror.CodeNotFound, "文件对象缺失")
	}
	if err != nil {
		return Download{}, apierror.Wrap(apierror.CodeInternal, "读取文件对象失败", err)
	}
	return Download{Filename: file.Filename, ContentType: contentType(file.ContentType), Content: value}, nil
}

func (s *Service) DeleteAttachment(ctx context.Context, actor *authz.Actor, id uuid.UUID) error {
	if actor == nil || !actor.HasPermission("sys.file:delete") {
		return apierror.New(apierror.CodeForbidden, "无权限删除附件")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var value Attachment
	err = tx.QueryRow(ctx, `
		SELECT id,file_id,owner_type,owner_id,category,company_id,inserted_at
		FROM sys_attachment WHERE id=$1 FOR UPDATE
	`, id).Scan(&value.ID, &value.FileID, &value.OwnerType, &value.OwnerID, &value.Category, &value.CompanyID, &value.InsertedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return apierror.New(apierror.CodeNotFound, "附件不存在")
	}
	if err != nil {
		return err
	}
	if value.CompanyID != nil && !actor.CanAccessCompany(*value.CompanyID) {
		return apierror.New(apierror.CodeForbidden, "无权限删除其他公司的附件")
	}
	if _, err = tx.Exec(ctx, "DELETE FROM sys_attachment WHERE id=$1", id); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除附件失败", err)
	}
	if err = audit.Write(ctx, tx, actor, audit.Entry{
		Resource: "sys_attachment", RecordID: id, RecordLabel: value.OwnerType,
		ActionType: "destroy", ActionName: "destroy",
		Changes: audit.Destroyed(attachmentSnapshot(value), attachmentAuditFields),
	}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Service) DeleteFile(ctx context.Context, actor *authz.Actor, id uuid.UUID) error {
	if actor == nil || !actor.HasPermission("sys.file:delete") {
		return apierror.New(apierror.CodeForbidden, "无权限删除文件")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var file File
	var size *int64
	var sha *string
	err = tx.QueryRow(ctx, `
		SELECT id,storage,key,filename,content_type,size,sha256,inserted_at,uploaded_by_id
		FROM sys_file WHERE id=$1 FOR UPDATE
	`, id).Scan(
		&file.ID, &file.Storage, &file.Key, &file.Filename, &file.ContentType,
		&size, &sha, &file.InsertedAt, &file.UploadedByID,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return apierror.New(apierror.CodeNotFound, "文件不存在")
	}
	if err != nil {
		return err
	}
	if size != nil {
		file.Size = *size
	}
	if sha != nil {
		file.SHA256 = *sha
	}
	var attachmentCount, templateCount int
	if err = tx.QueryRow(ctx, "SELECT count(*) FROM sys_attachment WHERE file_id=$1", id).Scan(&attachmentCount); err != nil {
		return err
	}
	if attachmentCount > 0 {
		return apierror.New(apierror.CodeConflict, "该文件仍有业务挂接，请先在业务单据中移除附件")
	}
	if err = tx.QueryRow(ctx, "SELECT count(*) FROM sys_print_template WHERE file_id=$1", id).Scan(&templateCount); err != nil {
		return err
	}
	if templateCount > 0 {
		return apierror.New(apierror.CodeConflict, "该文件仍被打印模板引用，请先删除或更换模板")
	}
	endpoint, err := storageByNameQuerier(ctx, tx, file.Storage)
	if err != nil {
		return err
	}
	store, err := endpoint.objectStorage()
	if err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, "DELETE FROM sys_file WHERE id=$1", id); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除文件元数据失败", err)
	}
	if err = audit.Write(ctx, tx, actor, audit.Entry{
		Resource: "sys_file", RecordID: id, RecordLabel: file.Filename,
		ActionType: "destroy", ActionName: "destroy",
		Changes: audit.Destroyed(fileSnapshot(file), fileAuditFields),
	}); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	cleanupCtx, cleanupCancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cleanupCancel()
	if err = store.Delete(cleanupCtx, file.Key); err != nil {
		slog.Default().Warn("提交后清理文件对象失败", "storage", file.Storage, "key", file.Key, "error", err)
	}
	return nil
}

func safeExtension(filename string) string {
	extension := strings.ToLower(filepath.Ext(filename))
	if extensionPattern.MatchString(extension) {
		return extension
	}
	return ""
}

func nullableString(value string) *string {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	return &value
}

func contentType(value *string) string {
	if value == nil || *value == "" {
		return "application/octet-stream"
	}
	return *value
}

var fileAuditFields = []string{"storage", "key", "filename", "content_type", "size", "sha256", "uploaded_by_id"}
var attachmentAuditFields = []string{"file_id", "owner_type", "owner_id", "category", "company_id"}

func fileSnapshot(value File) map[string]any {
	return map[string]any{
		"storage": value.Storage, "key": value.Key, "filename": value.Filename,
		"content_type": value.ContentType, "size": value.Size, "sha256": value.SHA256,
		"uploaded_by_id": value.UploadedByID,
	}
}

func attachmentSnapshot(value Attachment) map[string]any {
	return map[string]any{
		"file_id": value.FileID, "owner_type": value.OwnerType, "owner_id": value.OwnerID,
		"category": value.Category, "company_id": value.CompanyID,
	}
}
