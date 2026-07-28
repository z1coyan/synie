package systemops

import "github.com/z1coyan/synie/server/internal/platform/meta"

// ResourceMetas only contains resources that were public GridMeta resources in
// the legacy service. Todos use a purpose-built API and TodoState is internal.
func ResourceMetas() []meta.ResourceMeta {
	return []meta.ResourceMeta{AuditLogResourceMeta()}
}

func AuditLogResourceMeta() meta.ResourceMeta {
	return meta.ResourceMeta{
		Name: AuditLogResourceName, PermissionPrefix: "sys.audit_log",
		PermissionLabel: "操作日志", Table: "sys_audit_log", Print: true,
		Fields: []meta.FieldMeta{
			{Name: "id", APIName: "id", DBColumn: "id", Type: meta.TypeUUID, Label: "id", Readonly: true, Sortable: true},
			{Name: "inserted_at", APIName: "insertedAt", DBColumn: "inserted_at", Type: meta.TypeDatetime, Label: "操作时间", Readonly: true, Filterable: true, Sortable: true},
			{Name: "resource", APIName: "resource", DBColumn: "resource", Type: meta.TypeString, Label: "资源", Readonly: true, Filterable: true, Sortable: true},
			{Name: "record_id", APIName: "recordId", DBColumn: "record_id", Type: meta.TypeString, Label: "记录ID", Readonly: true, Sortable: true},
			{Name: "record_label", APIName: "recordLabel", DBColumn: "record_label", Type: meta.TypeString, Label: "记录名称", Readonly: true, Filterable: true, Sortable: true},
			{Name: "action_type", APIName: "actionType", DBColumn: "action_type", Type: meta.TypeString, Label: "操作类型", Readonly: true, Filterable: true, Sortable: true},
			{Name: "action_name", APIName: "actionName", DBColumn: "action_name", Type: meta.TypeString, Label: "动作", Readonly: true, Filterable: true, Sortable: true},
			{Name: "actor_id", APIName: "actorId", DBColumn: "actor_id", Type: meta.TypeString, Label: "操作人ID", Readonly: true, Sortable: true},
			{Name: "actor_name", APIName: "actorName", DBColumn: "actor_name", Type: meta.TypeString, Label: "操作人", Readonly: true, Filterable: true, Sortable: true},
			{Name: "company_id", APIName: "companyId", DBColumn: "company_id", Type: meta.TypeString, Label: "公司ID", Readonly: true, Sortable: true},
			{Name: "changes", APIName: "changes", DBColumn: "changes", Type: meta.TypeString, Label: "变更内容", Readonly: true},
		},
		Actions: []meta.ActionMeta{{Key: "read", Label: "查看", Scope: "both"}},
	}
}

func todoQueryMeta() meta.ResourceMeta {
	types := []meta.EnumOption{
		{Value: "ISSUE_INVOICE", Label: "开票"},
		{Value: "RECEIVE_INVOICE", Label: "收票"},
	}
	statuses := []meta.EnumOption{
		{Value: "ACTIVE", Label: "活跃"},
		{Value: "CLOSED", Label: "已关闭"},
	}
	reasons := []meta.EnumOption{
		{Value: "UNCONFIRM", Label: "撤回确认"},
		{Value: "INVOICE_AUDIT", Label: "发票审核结单"},
	}
	return meta.ResourceMeta{
		Name: "_sysTodosInternal", PermissionPrefix: "sys.todo",
		PermissionLabel: "待办", Table: "sys_todo",
		Fields: []meta.FieldMeta{
			{Name: "id", APIName: "id", DBColumn: "id", Type: meta.TypeUUID, Label: "id", Readonly: true, Sortable: true},
			{Name: "type", APIName: "type", DBColumn: "type", Type: meta.TypeEnum, Label: "待办类型", Readonly: true, Filterable: true, Sortable: true, EnumOptions: types},
			{Name: "source_type", APIName: "sourceType", DBColumn: "source_type", Type: meta.TypeString, Label: "源单据类型", Readonly: true, Filterable: true, Sortable: true},
			{Name: "source_id", APIName: "sourceId", DBColumn: "source_id", Type: meta.TypeUUID, Label: "源单据", Readonly: true, Filterable: true, Sortable: true},
			{Name: "source_no", APIName: "sourceNo", DBColumn: "source_no", Type: meta.TypeString, Label: "源单据号", Readonly: true, Filterable: true, Sortable: true},
			{Name: "party_type", APIName: "partyType", DBColumn: "party_type", Type: meta.TypeString, Label: "对手类型", Readonly: true, Filterable: true, Sortable: true},
			{Name: "party_id", APIName: "partyId", DBColumn: "party_id", Type: meta.TypeUUID, Label: "对手", Readonly: true, Filterable: true, Sortable: true},
			{Name: "amount", APIName: "amount", DBColumn: "amount", Type: meta.TypeDecimal, Label: "金额", Readonly: true, Filterable: true, Sortable: true},
			{Name: "status", APIName: "status", DBColumn: "status", Type: meta.TypeEnum, Label: "状态", Readonly: true, Filterable: true, Sortable: true, EnumOptions: statuses},
			{Name: "closed_reason", APIName: "closedReason", DBColumn: "closed_reason", Type: meta.TypeEnum, Label: "关闭原因", Readonly: true, Filterable: true, Sortable: true, EnumOptions: reasons},
			{Name: "source_changed_at", APIName: "sourceChangedAt", DBColumn: "source_changed_at", Type: meta.TypeDatetime, Label: "源单变化时间", Readonly: true, Filterable: true, Sortable: true},
			{Name: "closed_at", APIName: "closedAt", DBColumn: "closed_at", Type: meta.TypeDatetime, Label: "关闭时间", Readonly: true, Filterable: true, Sortable: true},
			{Name: "inserted_at", APIName: "insertedAt", DBColumn: "inserted_at", Type: meta.TypeDatetime, Label: "产生时间", Readonly: true, Filterable: true, Sortable: true},
			{Name: "updated_at", APIName: "updatedAt", DBColumn: "updated_at", Type: meta.TypeDatetime, Label: "更新时间", Readonly: true, Filterable: true, Sortable: true},
			{Name: "company_id", APIName: "companyId", DBColumn: "company_id", Type: meta.TypeUUID, Label: "公司", Readonly: true, Filterable: true, Sortable: true},
			{Name: "created_by_id", APIName: "createdById", DBColumn: "created_by_id", Type: meta.TypeUUID, Label: "触发操作人", Readonly: true, Filterable: true, Sortable: true},
		},
	}
}
