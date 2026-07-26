package employee

import "github.com/z1coyan/synie/server/internal/platform/meta"

const ResourceName = "hrEmployees"

var (
	auditedFields = []string{
		"code", "name", "attendance_no", "id_number", "household_registration", "phone",
		"current_address", "daily_wage", "monthly_allowance", "insurance_types",
	}
	insuranceOptions = []meta.EnumOption{
		{Value: "SOCIAL_INJURY", Label: "社保工伤"},
		{Value: "SOCIAL_UNEMPLOYMENT", Label: "社保失业"},
		{Value: "SOCIAL_MEDICAL", Label: "社保医疗"},
		{Value: "SOCIAL_PENSION", Label: "社保养老"},
		{Value: "SOCIAL_MATERNITY", Label: "社保生育"},
		{Value: "HOUSING_FUND", Label: "公积金"},
		{Value: "COMMERCIAL_INJURY", Label: "商保工伤"},
		{Value: "COMMERCIAL_MEDICAL", Label: "商保医疗"},
	}
)

func ResourceMeta() meta.ResourceMeta {
	destroy := "destroyHrEmployee"
	return meta.ResourceMeta{
		Name: ResourceName, PermissionPrefix: "hr.employee",
		PermissionLabel: "员工", Table: "hr_employees",
		Fields: []meta.FieldMeta{
			{Name: "id", APIName: "id", DBColumn: "id", Type: meta.TypeUUID, Label: "id", Readonly: true, Sortable: true},
			// 数据库列最终非空，但 create 可留空走 hr.employee 编号规则，故 Form/Meta 不标 required。
			{Name: "code", APIName: "code", DBColumn: "code", Type: meta.TypeString, Label: "员工编号", Filterable: true, Sortable: true},
			{Name: "name", APIName: "name", DBColumn: "name", Type: meta.TypeString, Label: "员工姓名", Required: true, Filterable: true, Sortable: true},
			{Name: "attendance_no", APIName: "attendanceNo", DBColumn: "attendance_no", Type: meta.TypeString, Label: "考勤设备编号", Filterable: true, Sortable: true},
			{Name: "id_number", APIName: "idNumber", DBColumn: "id_number", Type: meta.TypeString, Label: "身份证号", Filterable: true, Sortable: true},
			{Name: "household_registration", APIName: "householdRegistration", DBColumn: "household_registration", Type: meta.TypeString, Label: "户籍", Filterable: true, Sortable: true},
			{Name: "phone", APIName: "phone", DBColumn: "phone", Type: meta.TypeString, Label: "手机号码", Filterable: true, Sortable: true},
			{Name: "current_address", APIName: "currentAddress", DBColumn: "current_address", Type: meta.TypeString, Label: "现居住地", Filterable: true, Sortable: true},
			{Name: "daily_wage", APIName: "dailyWage", DBColumn: "daily_wage", Type: meta.TypeDecimal, Label: "日薪", Filterable: true, Sortable: true},
			{Name: "monthly_allowance", APIName: "monthlyAllowance", DBColumn: "monthly_allowance", Type: meta.TypeDecimal, Label: "月补贴", Filterable: true, Sortable: true},
			{Name: "insurance_types", APIName: "insuranceTypes", DBColumn: "insurance_types", Type: meta.TypeEnumArray, Label: "参保类型", EnumOptions: insuranceOptions, Filterable: true},
			{Name: "inserted_at", APIName: "insertedAt", DBColumn: "inserted_at", Type: meta.TypeDatetime, Label: "创建时间", Readonly: true, Filterable: true, Sortable: true},
			{Name: "updated_at", APIName: "updatedAt", DBColumn: "updated_at", Type: meta.TypeDatetime, Label: "更新时间", Readonly: true, Filterable: true, Sortable: true},
		},
		Actions: []meta.ActionMeta{
			{Key: "read", Label: "查看", Scope: "both"},
			{Key: "create", Label: "新增", Scope: "both"},
			{Key: "update", Label: "编辑", Scope: "row"},
			{Key: "delete", Label: "删除", Scope: "row", IsDanger: true},
		},
		Form: &meta.FormMetaDTO{
			Exclude: []string{"id", "insertedAt", "updatedAt"},
			Fields: map[string]map[string]any{
				"code": {"required": false, "placeholder": "留空自动编号"},
				"name": {"required": true},
			},
		},
		Print: true,
		Audit: meta.AuditMeta{
			Enabled: true, SensitiveFields: []string{"id_number"},
		},
		DestroyMutation: &destroy,
	}
}
