package files

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/audit"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

var storageNamePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]*$`)

type storageConfig struct {
	StorageEndpoint
	secretAccessKey string
}

func (value storageConfig) objectStorage() (ObjectStorage, error) {
	switch strings.ToLower(value.Kind) {
	case "local":
		if value.Root == nil || strings.TrimSpace(*value.Root) == "" {
			return nil, apierror.New(apierror.CodeInternal, "本地存储缺少根目录配置")
		}
		return LocalStorage{Root: *value.Root}, nil
	case "s3", "oss":
		if value.Endpoint == nil || value.Bucket == nil || value.AccessKeyID == nil || value.secretAccessKey == "" {
			return nil, apierror.New(apierror.CodeInternal, "对象存储配置不完整")
		}
		store, err := NewS3Storage(
			*value.Endpoint, stringValue(value.Region), *value.Bucket, stringValue(value.Prefix),
			*value.AccessKeyID, value.secretAccessKey, value.Kind,
		)
		if err != nil {
			return nil, apierror.Wrap(apierror.CodeInternal, "对象存储配置不合法", err)
		}
		return store, nil
	default:
		return nil, apierror.New(apierror.CodeInternal, "未知的存储类型")
	}
}

type StorageService struct{ pool *pgxpool.Pool }

func NewStorageService(pool *pgxpool.Pool) *StorageService { return &StorageService{pool: pool} }

func (s *Service) defaultStorage(ctx context.Context) (storageConfig, error) {
	var value storageConfig
	err := s.pool.QueryRow(ctx, `
		SELECT id,name,label,kind,root,endpoint,region,bucket,prefix,access_key_id,
		       COALESCE(secret_access_key,''),builtin,is_default,inserted_at,updated_at
		FROM sys_storage WHERE is_default=true
	`).Scan(
		&value.ID, &value.Name, &value.Label, &value.Kind, &value.Root, &value.Endpoint,
		&value.Region, &value.Bucket, &value.Prefix, &value.AccessKeyID, &value.secretAccessKey,
		&value.Builtin, &value.IsDefault, &value.InsertedAt, &value.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return storageConfig{}, apierror.New(apierror.CodeConflict, "存储接入未初始化：没有默认接入点")
	}
	if err != nil {
		return storageConfig{}, apierror.Wrap(apierror.CodeInternal, "读取默认存储失败", err)
	}
	return normalizeStorageOutput(value), nil
}

func (s *Service) storageByName(ctx context.Context, name string) (storageConfig, error) {
	return storageByNameQuerier(ctx, s.pool, name)
}

func storageByNameQuerier(ctx context.Context, q rowQuerier, name string) (storageConfig, error) {
	var value storageConfig
	err := q.QueryRow(ctx, `
		SELECT id,name,label,kind,root,endpoint,region,bucket,prefix,access_key_id,
		       COALESCE(secret_access_key,''),builtin,is_default,inserted_at,updated_at
		FROM sys_storage WHERE name=$1
	`, name).Scan(
		&value.ID, &value.Name, &value.Label, &value.Kind, &value.Root, &value.Endpoint,
		&value.Region, &value.Bucket, &value.Prefix, &value.AccessKeyID, &value.secretAccessKey,
		&value.Builtin, &value.IsDefault, &value.InsertedAt, &value.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return storageConfig{}, apierror.New(apierror.CodeNotFound, "存储接入不存在")
	}
	if err != nil {
		return storageConfig{}, apierror.Wrap(apierror.CodeInternal, "读取存储接入失败", err)
	}
	return normalizeStorageOutput(value), nil
}

func (s *StorageService) Get(ctx context.Context, id uuid.UUID) (StorageEndpoint, error) {
	var value StorageEndpoint
	err := s.pool.QueryRow(ctx, `
		SELECT id,name,label,kind,root,endpoint,region,bucket,prefix,access_key_id,
		       secret_access_key IS NOT NULL AND btrim(secret_access_key) <> '',
		       builtin,is_default,inserted_at,updated_at
		FROM sys_storage WHERE id=$1
	`, id).Scan(
		&value.ID, &value.Name, &value.Label, &value.Kind, &value.Root, &value.Endpoint,
		&value.Region, &value.Bucket, &value.Prefix, &value.AccessKeyID, &value.SecretConfigured,
		&value.Builtin, &value.IsDefault, &value.InsertedAt, &value.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return StorageEndpoint{}, apierror.New(apierror.CodeNotFound, "存储接入不存在")
	}
	if err != nil {
		return StorageEndpoint{}, apierror.Wrap(apierror.CodeInternal, "读取存储接入失败", err)
	}
	value.Kind = strings.ToUpper(value.Kind)
	value.InsertedAt = value.InsertedAt.UTC()
	value.UpdatedAt = value.UpdatedAt.UTC()
	return value, nil
}

func (s *StorageService) List(ctx context.Context, query ListQuery) (StorageList, error) {
	if query.Limit == 0 {
		query.Limit = 20
	}
	if query.Limit < 1 || query.Limit > 200 || query.Offset < 0 {
		return StorageList{}, apierror.Validation("分页参数不合法", map[string][]string{"limit": {"必须在 1 到 200 之间"}})
	}
	built, err := filterbuild.Build(StorageResourceMeta(), filterbuild.Query{
		Limit: query.Limit, Offset: query.Offset, Search: query.Search, Sort: query.Sort, Filter: query.Filter,
	})
	if err != nil {
		return StorageList{}, err
	}
	order := built.OrderBy
	if order == "" {
		order = ` ORDER BY "is_default" DESC, "label", "id"`
	} else {
		order += `, "id"`
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return StorageList{}, err
	}
	defer tx.Rollback(ctx)
	var result StorageList
	if err = tx.QueryRow(ctx, "SELECT count(*) FROM sys_storage"+built.Where, built.Args...).Scan(&result.Count); err != nil {
		return result, apierror.Wrap(apierror.CodeInternal, "统计存储接入失败", err)
	}
	args := append([]any(nil), built.Args...)
	n := len(args) + 1
	args = append(args, query.Limit, query.Offset)
	rows, err := tx.Query(ctx, `
		SELECT id,name,label,kind,root,endpoint,region,bucket,prefix,access_key_id,
		       secret_access_key IS NOT NULL AND btrim(secret_access_key) <> '',
		       builtin,is_default,inserted_at,updated_at
		FROM sys_storage`+built.Where+order+fmt.Sprintf(" LIMIT $%d OFFSET $%d", n, n+1), args...)
	if err != nil {
		return result, apierror.Wrap(apierror.CodeInternal, "查询存储接入失败", err)
	}
	defer rows.Close()
	result.Results = make([]StorageEndpoint, 0, query.Limit)
	for rows.Next() {
		var value StorageEndpoint
		if err = rows.Scan(
			&value.ID, &value.Name, &value.Label, &value.Kind, &value.Root, &value.Endpoint,
			&value.Region, &value.Bucket, &value.Prefix, &value.AccessKeyID, &value.SecretConfigured,
			&value.Builtin, &value.IsDefault, &value.InsertedAt, &value.UpdatedAt,
		); err != nil {
			return result, err
		}
		value.Kind = strings.ToUpper(value.Kind)
		value.InsertedAt = value.InsertedAt.UTC()
		value.UpdatedAt = value.UpdatedAt.UTC()
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

func (s *StorageService) Create(ctx context.Context, actor *authz.Actor, input StorageCreateInput) (StorageEndpoint, error) {
	normalized, err := validateStorageInput(input, "")
	if err != nil {
		return StorageEndpoint{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return StorageEndpoint{}, err
	}
	defer tx.Rollback(ctx)
	var id uuid.UUID
	err = tx.QueryRow(ctx, `
		INSERT INTO sys_storage
		  (name,label,kind,root,endpoint,region,bucket,prefix,access_key_id,secret_access_key)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
		RETURNING id
	`, normalized.Name, normalized.Label, strings.ToLower(normalized.Kind), normalized.Root, normalized.Endpoint,
		normalized.Region, normalized.Bucket, normalized.Prefix, normalized.AccessKeyID, normalized.SecretAccessKey,
	).Scan(&id)
	if err != nil {
		return StorageEndpoint{}, storageWriteError(err)
	}
	value, err := getStorageTx(ctx, tx, id)
	if err != nil {
		return StorageEndpoint{}, err
	}
	if err = audit.Write(ctx, tx, actor, audit.Entry{
		Resource: "sys_storage", RecordID: id, RecordLabel: value.Label,
		ActionType: "create", ActionName: "create",
		Changes: audit.Created(storageSnapshot(value), storageAuditFields),
	}); err != nil {
		return StorageEndpoint{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return StorageEndpoint{}, storageWriteError(err)
	}
	return value, nil
}

func (s *StorageService) Update(ctx context.Context, actor *authz.Actor, id uuid.UUID, input StorageUpdateInput) (StorageEndpoint, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return StorageEndpoint{}, err
	}
	defer tx.Rollback(ctx)
	beforeConfig, err := lockStorage(ctx, tx, id)
	if err != nil {
		return StorageEndpoint{}, err
	}
	merged := StorageCreateInput{
		Name: beforeConfig.Name, Label: beforeConfig.Label, Kind: beforeConfig.Kind,
		Root: beforeConfig.Root, Endpoint: beforeConfig.Endpoint, Region: beforeConfig.Region,
		Bucket: beforeConfig.Bucket, Prefix: beforeConfig.Prefix, AccessKeyID: beforeConfig.AccessKeyID,
	}
	oldSecret := beforeConfig.secretAccessKey
	if input.Label != nil {
		merged.Label = *input.Label
	}
	applyPatch := func(patch **string, target **string) {
		if patch != nil {
			*target = *patch
		}
	}
	applyPatch(input.Root, &merged.Root)
	applyPatch(input.Endpoint, &merged.Endpoint)
	applyPatch(input.Region, &merged.Region)
	applyPatch(input.Bucket, &merged.Bucket)
	applyPatch(input.Prefix, &merged.Prefix)
	applyPatch(input.AccessKeyID, &merged.AccessKeyID)
	secret := oldSecret
	if input.SecretAccessKey != nil && strings.TrimSpace(*input.SecretAccessKey) != "" {
		secret = *input.SecretAccessKey
	}
	merged.SecretAccessKey = &secret
	normalized, err := validateStorageInput(merged, oldSecret)
	if err != nil {
		return StorageEndpoint{}, err
	}
	_, err = tx.Exec(ctx, `
		UPDATE sys_storage SET label=$2,root=$3,endpoint=$4,region=$5,bucket=$6,prefix=$7,
		  access_key_id=$8,secret_access_key=$9,updated_at=(now() AT TIME ZONE 'utc')
		WHERE id=$1
	`, id, normalized.Label, normalized.Root, normalized.Endpoint, normalized.Region, normalized.Bucket,
		normalized.Prefix, normalized.AccessKeyID, normalized.SecretAccessKey,
	)
	if err != nil {
		return StorageEndpoint{}, storageWriteError(err)
	}
	after, err := getStorageTx(ctx, tx, id)
	if err != nil {
		return StorageEndpoint{}, err
	}
	changes := audit.Diff(storageSnapshot(beforeConfig.StorageEndpoint), storageSnapshot(after), storageAuditFields)
	if len(changes) > 0 {
		if err = audit.Write(ctx, tx, actor, audit.Entry{
			Resource: "sys_storage", RecordID: id, RecordLabel: after.Label,
			ActionType: "update", ActionName: "update", Changes: changes,
		}); err != nil {
			return StorageEndpoint{}, err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return StorageEndpoint{}, storageWriteError(err)
	}
	return after, nil
}

func (s *StorageService) SetDefault(ctx context.Context, actor *authz.Actor, id uuid.UUID) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtext('sys_storage_default'))"); err != nil {
		return err
	}
	target, err := getStorageTx(ctx, tx, id)
	if err != nil {
		return err
	}
	rows, err := tx.Query(ctx, `
		SELECT id,name,label,kind,root,endpoint,region,bucket,prefix,access_key_id,
		       secret_access_key IS NOT NULL AND btrim(secret_access_key) <> '',
		       builtin,is_default,inserted_at,updated_at
		FROM sys_storage WHERE is_default=true AND id<>$1 FOR UPDATE
	`, id)
	if err != nil {
		return err
	}
	var previous []StorageEndpoint
	for rows.Next() {
		var value StorageEndpoint
		if err = scanStorage(rows, &value); err != nil {
			rows.Close()
			return err
		}
		previous = append(previous, value)
	}
	rows.Close()
	if _, err = tx.Exec(ctx, "UPDATE sys_storage SET is_default=false,updated_at=(now() AT TIME ZONE 'utc') WHERE is_default=true AND id<>$1", id); err != nil {
		return storageWriteError(err)
	}
	if _, err = tx.Exec(ctx, "UPDATE sys_storage SET is_default=true,updated_at=(now() AT TIME ZONE 'utc') WHERE id=$1", id); err != nil {
		return storageWriteError(err)
	}
	for _, value := range previous {
		after := value
		after.IsDefault = false
		if err = audit.Write(ctx, tx, actor, audit.Entry{
			Resource: "sys_storage", RecordID: value.ID, RecordLabel: value.Label,
			ActionType: "update", ActionName: "unset_default",
			Changes: audit.Diff(storageSnapshot(value), storageSnapshot(after), storageAuditFields),
		}); err != nil {
			return err
		}
	}
	if !target.IsDefault {
		after := target
		after.IsDefault = true
		if err = audit.Write(ctx, tx, actor, audit.Entry{
			Resource: "sys_storage", RecordID: id, RecordLabel: target.Label,
			ActionType: "update", ActionName: "set_default",
			Changes: audit.Diff(storageSnapshot(target), storageSnapshot(after), storageAuditFields),
		}); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (s *StorageService) Delete(ctx context.Context, actor *authz.Actor, id uuid.UUID) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	value, err := getStorageTx(ctx, tx, id)
	if err != nil {
		return err
	}
	if value.Builtin {
		return apierror.New(apierror.CodeConflict, "内置存储接入不可删除")
	}
	if value.IsDefault {
		return apierror.New(apierror.CodeConflict, "默认存储接入不可删除，请先将其他接入点设为默认")
	}
	var count int
	if err = tx.QueryRow(ctx, "SELECT count(*) FROM sys_file WHERE storage=$1", value.Name).Scan(&count); err != nil {
		return err
	}
	if count > 0 {
		return apierror.New(apierror.CodeConflict, "仍有文件存于该接入点，不可删除")
	}
	if _, err = tx.Exec(ctx, "DELETE FROM sys_storage WHERE id=$1", id); err != nil {
		return storageWriteError(err)
	}
	if err = audit.Write(ctx, tx, actor, audit.Entry{
		Resource: "sys_storage", RecordID: id, RecordLabel: value.Label,
		ActionType: "destroy", ActionName: "destroy",
		Changes: audit.Destroyed(storageSnapshot(value), storageAuditFields),
	}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func validateStorageInput(input StorageCreateInput, oldSecret string) (StorageCreateInput, error) {
	input.Name = strings.TrimSpace(input.Name)
	input.Label = strings.TrimSpace(input.Label)
	input.Kind = strings.ToUpper(strings.TrimSpace(input.Kind))
	input.Root = trimPointer(input.Root)
	input.Endpoint = trimPointer(input.Endpoint)
	input.Region = trimPointer(input.Region)
	input.Bucket = trimPointer(input.Bucket)
	input.Prefix = trimPointer(input.Prefix)
	input.AccessKeyID = trimPointer(input.AccessKeyID)
	fields := map[string][]string{}
	if !storageNamePattern.MatchString(input.Name) || len(input.Name) > 32 {
		fields["name"] = []string{"接入名只能用小写字母、数字、中划线、下划线，且以字母或数字开头，最多 32 个字符"}
	}
	if input.Label == "" || len([]rune(input.Label)) > 64 {
		fields["label"] = []string{"显示名必填且最多 64 个字符"}
	}
	switch input.Kind {
	case "LOCAL":
		if input.Root == nil {
			fields["root"] = []string{"该存储类型下「根目录」必填"}
		}
	case "S3", "OSS":
		if input.Endpoint == nil {
			fields["endpoint"] = []string{"该存储类型下「服务地址」必填"}
		}
		if input.Bucket == nil {
			fields["bucket"] = []string{"该存储类型下「Bucket」必填"}
		}
		if input.AccessKeyID == nil {
			fields["accessKeyId"] = []string{"该存储类型下「Access Key ID」必填"}
		}
		secret := oldSecret
		if input.SecretAccessKey != nil && strings.TrimSpace(*input.SecretAccessKey) != "" {
			secret = *input.SecretAccessKey
		}
		if secret == "" {
			fields["secretAccessKey"] = []string{"该存储类型下「Secret Access Key」必填"}
		} else {
			input.SecretAccessKey = &secret
		}
	default:
		fields["kind"] = []string{"仅支持 LOCAL、S3、OSS"}
	}
	if len(fields) > 0 {
		return StorageCreateInput{}, apierror.Validation("存储接入参数不合法", fields)
	}
	return input, nil
}

func lockStorage(ctx context.Context, tx pgx.Tx, id uuid.UUID) (storageConfig, error) {
	var value storageConfig
	err := tx.QueryRow(ctx, `
		SELECT id,name,label,kind,root,endpoint,region,bucket,prefix,access_key_id,
		       COALESCE(secret_access_key,''),builtin,is_default,inserted_at,updated_at
		FROM sys_storage WHERE id=$1 FOR UPDATE
	`, id).Scan(
		&value.ID, &value.Name, &value.Label, &value.Kind, &value.Root, &value.Endpoint,
		&value.Region, &value.Bucket, &value.Prefix, &value.AccessKeyID, &value.secretAccessKey,
		&value.Builtin, &value.IsDefault, &value.InsertedAt, &value.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return storageConfig{}, apierror.New(apierror.CodeNotFound, "存储接入不存在")
	}
	if err != nil {
		return storageConfig{}, err
	}
	return normalizeStorageOutput(value), nil
}

func getStorageTx(ctx context.Context, tx pgx.Tx, id uuid.UUID) (StorageEndpoint, error) {
	var value StorageEndpoint
	err := tx.QueryRow(ctx, `
		SELECT id,name,label,kind,root,endpoint,region,bucket,prefix,access_key_id,
		       secret_access_key IS NOT NULL AND btrim(secret_access_key) <> '',
		       builtin,is_default,inserted_at,updated_at
		FROM sys_storage WHERE id=$1
	`, id).Scan(
		&value.ID, &value.Name, &value.Label, &value.Kind, &value.Root, &value.Endpoint,
		&value.Region, &value.Bucket, &value.Prefix, &value.AccessKeyID, &value.SecretConfigured,
		&value.Builtin, &value.IsDefault, &value.InsertedAt, &value.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return StorageEndpoint{}, apierror.New(apierror.CodeNotFound, "存储接入不存在")
	}
	if err != nil {
		return StorageEndpoint{}, err
	}
	value.Kind = strings.ToUpper(value.Kind)
	value.InsertedAt = value.InsertedAt.UTC()
	value.UpdatedAt = value.UpdatedAt.UTC()
	return value, nil
}

type storageScanner interface{ Scan(...any) error }

func scanStorage(scanner storageScanner, value *StorageEndpoint) error {
	err := scanner.Scan(
		&value.ID, &value.Name, &value.Label, &value.Kind, &value.Root, &value.Endpoint,
		&value.Region, &value.Bucket, &value.Prefix, &value.AccessKeyID, &value.SecretConfigured,
		&value.Builtin, &value.IsDefault, &value.InsertedAt, &value.UpdatedAt,
	)
	value.Kind = strings.ToUpper(value.Kind)
	value.InsertedAt = value.InsertedAt.UTC()
	value.UpdatedAt = value.UpdatedAt.UTC()
	return err
}

func normalizeStorageOutput(value storageConfig) storageConfig {
	value.Kind = strings.ToUpper(value.Kind)
	value.SecretConfigured = strings.TrimSpace(value.secretAccessKey) != ""
	value.InsertedAt = value.InsertedAt.UTC()
	value.UpdatedAt = value.UpdatedAt.UTC()
	return value
}

func trimPointer(value *string) *string {
	if value == nil {
		return nil
	}
	trimmed := strings.TrimSpace(*value)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

func stringValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func storageWriteError(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		if pgErr.Code == "23505" {
			if pgErr.ConstraintName == "sys_storage_single_default_index" {
				return apierror.Wrap(apierror.CodeConflict, "全局默认存储只能有一个", err)
			}
			return apierror.Wrap(apierror.CodeConflict, "接入名已存在", err)
		}
	}
	return apierror.Wrap(apierror.CodeInternal, "保存存储接入失败", err)
}

var storageAuditFields = []string{
	"name", "label", "kind", "root", "endpoint", "region", "bucket", "prefix",
	"access_key_id", "builtin", "is_default",
}

func storageSnapshot(value StorageEndpoint) map[string]any {
	return map[string]any{
		"name": value.Name, "label": value.Label, "kind": strings.ToLower(value.Kind),
		"root": value.Root, "endpoint": value.Endpoint, "region": value.Region,
		"bucket": value.Bucket, "prefix": value.Prefix, "access_key_id": value.AccessKeyID,
		"builtin": value.Builtin, "is_default": value.IsDefault,
	}
}
