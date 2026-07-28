package employee

import (
	"slices"
	"testing"

	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/platform/meta"
)

func TestEmployeeMetaMatchesLegacyGridAndFormContract(t *testing.T) {
	resource := ResourceMeta()
	if resource.Name != "hrEmployees" || resource.PermissionPrefix != "hr.employee" ||
		resource.DestroyMutation == nil || *resource.DestroyMutation != "destroyHrEmployee" {
		t.Fatalf("resource = %#v", resource)
	}
	wantNames := []string{
		"id", "code", "name", "attendanceNo", "idNumber", "householdRegistration",
		"phone", "currentAddress", "dailyWage", "monthlyAllowance", "insuranceTypes",
		"insertedAt", "updatedAt",
	}
	gotNames := make([]string, len(resource.Fields))
	var insurance meta.FieldMeta
	for i, field := range resource.Fields {
		gotNames[i] = field.APIName
		if field.APIName == "insuranceTypes" {
			insurance = field
		}
	}
	if !slices.Equal(gotNames, wantNames) {
		t.Fatalf("columns = %#v", gotNames)
	}
	if insurance.Type != meta.TypeEnumArray || insurance.Sortable || !insurance.Filterable ||
		len(insurance.EnumOptions) != 8 ||
		insurance.EnumOptions[0] != (meta.EnumOption{Value: "SOCIAL_INJURY", Label: "社保工伤"}) ||
		insurance.EnumOptions[7] != (meta.EnumOption{Value: "COMMERCIAL_MEDICAL", Label: "商保医疗"}) {
		t.Fatalf("insurance meta = %#v", insurance)
	}
	if resource.Form == nil || resource.Form.Fields["code"]["required"] != false ||
		resource.Form.Fields["code"]["placeholder"] != "留空自动编号" {
		t.Fatalf("employee code form = %#v", resource.Form)
	}
	if !slices.Contains(resource.Audit.SensitiveFields, "id_number") {
		t.Fatalf("audit sensitive fields = %#v", resource.Audit.SensitiveFields)
	}
	registry := meta.NewRegistry()
	registry.MustRegister(resource)
	readOnly := &authz.Actor{Permissions: map[string]struct{}{"hr.employee:read": {}}}
	document, err := registry.BuildDocument(ResourceName, readOnly)
	if err != nil {
		t.Fatal(err)
	}
	if len(document.Grid.Columns) != 13 || document.Grid.Columns[4].Name != "idNumber" {
		t.Fatalf("wire columns = %#v", document.Grid.Columns)
	}
	if len(document.Grid.Capabilities) != 0 {
		t.Fatalf("read-only capabilities = %#v", document.Grid.Capabilities)
	}
	document, err = registry.BuildDocument(ResourceName, &authz.Actor{SuperAdmin: true})
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(document.Grid.Capabilities, []string{"create", "update", "delete"}) {
		t.Fatalf("capabilities = %#v", document.Grid.Capabilities)
	}
}

func TestEmployeeCreateWithoutNumbererReportsMissingRuleBeforeDatabaseAccess(t *testing.T) {
	_, err := NewService(nil, nil).Create(t.Context(), nil, CreateInput{Name: "张三"})
	if apierrorCode(err) != "conflict" {
		t.Fatalf("error = %#v", err)
	}
}
