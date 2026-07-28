package files

import "github.com/z1coyan/synie/server/internal/platform/meta"

const (
	FileResourceName    = "sysFiles"
	StorageResourceName = "sysStorages"
)

func FileResourceMeta() meta.ResourceMeta {
	destroy := "destroySysFile"
	return meta.ResourceMeta{
		Name: FileResourceName, PermissionPrefix: "sys.file", PermissionLabel: "附件",
		Table: "sys_file", Print: true, Audit: meta.AuditMeta{Enabled: true},
		Fields: []meta.FieldMeta{
			{Name: "id", APIName: "id", DBColumn: "id", Type: meta.TypeUUID, Label: "id", Readonly: true, Sortable: true},
			{Name: "storage", APIName: "storage", DBColumn: "storage", Type: meta.TypeString, Label: "存储接入", Readonly: true, Filterable: true, Sortable: true},
			{Name: "key", APIName: "key", DBColumn: "key", Type: meta.TypeString, Label: "对象键", Readonly: true, Filterable: true, Sortable: true},
			{Name: "filename", APIName: "filename", DBColumn: "filename", Type: meta.TypeString, Label: "文件名", Readonly: true, Filterable: true, Sortable: true},
			{Name: "content_type", APIName: "contentType", DBColumn: "content_type", Type: meta.TypeString, Label: "MIME 类型", Readonly: true, Filterable: true, Sortable: true},
			{Name: "size", APIName: "size", DBColumn: "size", Type: meta.TypeInteger, Label: "大小", Readonly: true, Filterable: true, Sortable: true},
			{Name: "sha256", APIName: "sha256", DBColumn: "sha256", Type: meta.TypeString, Label: "SHA-256 摘要", Readonly: true, Filterable: true, Sortable: true},
			{Name: "inserted_at", APIName: "insertedAt", DBColumn: "inserted_at", Type: meta.TypeDatetime, Label: "上传时间", Readonly: true, Filterable: true, Sortable: true},
			{Name: "uploaded_by_id", APIName: "uploadedById", DBColumn: "uploaded_by_id", Type: meta.TypeUUID, Label: "上传人", Readonly: true, Filterable: true,
				Ref: &meta.GridColumnRef{Resource: metaString("sysUsers"), Relation: metaString("uploadedBy"), LabelField: metaString("name")}},
		},
		Actions: []meta.ActionMeta{
			{Key: "read", Label: "查看", Scope: "both"},
			{Key: "create", Label: "上传", Scope: "both"},
			{Key: "delete", Label: "删除", Scope: "row", IsDanger: true},
		},
		Form:            &meta.FormMetaDTO{Exclude: []string{"id", "storage", "key", "insertedAt"}},
		DestroyMutation: &destroy,
	}
}

func StorageResourceMeta() meta.ResourceMeta {
	destroy := "destroySysStorage"
	kinds := []meta.EnumOption{
		{Value: "LOCAL", Label: "本地磁盘"},
		{Value: "S3", Label: "S3 兼容"},
		{Value: "OSS", Label: "阿里云 OSS"},
	}
	return meta.ResourceMeta{
		Name: StorageResourceName, PermissionPrefix: "sys.storage", PermissionLabel: "存储接入",
		Table: "sys_storage", Print: true, Audit: meta.AuditMeta{Enabled: true, SensitiveFields: []string{"secret_access_key"}},
		Fields: []meta.FieldMeta{
			{Name: "id", APIName: "id", DBColumn: "id", Type: meta.TypeUUID, Label: "id", Readonly: true, Sortable: true},
			{Name: "name", APIName: "name", DBColumn: "name", Type: meta.TypeString, Label: "接入名", Required: true, CreateOnly: true, Filterable: true, Sortable: true},
			{Name: "label", APIName: "label", DBColumn: "label", Type: meta.TypeString, Label: "显示名", Required: true, Filterable: true, Sortable: true},
			{Name: "kind", APIName: "kind", DBColumn: "kind", Type: meta.TypeEnum, Label: "存储类型", Required: true, CreateOnly: true, EnumOptions: kinds, Filterable: true, Sortable: true},
			{Name: "root", APIName: "root", DBColumn: "root", Type: meta.TypeString, Label: "根目录", Filterable: true, Sortable: true},
			{Name: "endpoint", APIName: "endpoint", DBColumn: "endpoint", Type: meta.TypeString, Label: "服务地址", Filterable: true, Sortable: true},
			{Name: "region", APIName: "region", DBColumn: "region", Type: meta.TypeString, Label: "区域", Filterable: true, Sortable: true},
			{Name: "bucket", APIName: "bucket", DBColumn: "bucket", Type: meta.TypeString, Label: "Bucket", Filterable: true, Sortable: true},
			{Name: "prefix", APIName: "prefix", DBColumn: "prefix", Type: meta.TypeString, Label: "对象键前缀", Filterable: true, Sortable: true},
			{Name: "access_key_id", APIName: "accessKeyId", DBColumn: "access_key_id", Type: meta.TypeString, Label: "Access Key ID", Filterable: true, Sortable: true},
			{Name: "secret_access_key", APIName: "secretAccessKey", DBColumn: "secret_access_key", Type: meta.TypeString, Label: "Secret Access Key", Sensitive: true},
			{Name: "builtin", APIName: "builtin", DBColumn: "builtin", Type: meta.TypeBoolean, Label: "内置", Readonly: true, Filterable: true, Sortable: true},
			{Name: "is_default", APIName: "isDefault", DBColumn: "is_default", Type: meta.TypeBoolean, Label: "全局默认", Readonly: true, Filterable: true, Sortable: true},
			{Name: "inserted_at", APIName: "insertedAt", DBColumn: "inserted_at", Type: meta.TypeDatetime, Label: "创建时间", Readonly: true, Filterable: true, Sortable: true},
			{Name: "updated_at", APIName: "updatedAt", DBColumn: "updated_at", Type: meta.TypeDatetime, Label: "更新时间", Readonly: true, Filterable: true, Sortable: true},
		},
		Actions: []meta.ActionMeta{
			{Key: "read", Label: "查看", Scope: "both"},
			{Key: "create", Label: "新增", Scope: "both"},
			{Key: "update", Label: "编辑", Scope: "row"},
			{Key: "delete", Label: "删除", Scope: "row", IsDanger: true},
			{Key: "setDefault", Label: "设为默认", Scope: "row", PermissionAction: "update",
				HTTP: &meta.HTTPAction{Method: "POST", Path: "/api/v1/system/storages/{id}/set-default"}},
		},
		Form: &meta.FormMetaDTO{
			Exclude: []string{"id", "insertedAt", "updatedAt"},
			Fields: map[string]map[string]any{
				"name": {"edit": "createOnly"}, "kind": {"edit": "createOnly"},
				"builtin": {"edit": "readOnly"}, "isDefault": {"edit": "readOnly"},
			},
		},
		DestroyMutation: &destroy,
	}
}
