package master

import (
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

const (
	operationPermission = "mfg.operation"
	templatePermission  = "mfg.route_template"
	bomPermission       = "mfg.bom"
)

func require(actor *authz.Actor, prefix, action string) error {
	if actor == nil || !actor.HasPermission(prefix+":"+action) {
		return apierror.New(apierror.CodeForbidden, "无权限执行制造主数据操作")
	}
	return nil
}

func requireChild(actor *authz.Actor, prefix, action string) error {
	switch action {
	case "read":
		return require(actor, prefix, "read")
	case "create":
		if actor != nil && (actor.HasPermission(prefix+":update") || actor.HasPermission(prefix+":create")) {
			return nil
		}
	default:
		return require(actor, prefix, "update")
	}
	return apierror.New(apierror.CodeForbidden, "无权限执行制造主数据行操作")
}

func normalizeHead(code, name string, note *string, label string) (string, string, *string, error) {
	code, name, note = strings.TrimSpace(code), strings.TrimSpace(name), trimOptional(note)
	fields := map[string][]string{}
	if utf8.RuneCountInString(code) > 32 {
		fields["code"] = []string{"最多 32 个字符"}
	}
	if name == "" || utf8.RuneCountInString(name) > 64 {
		fields["name"] = []string{"不能为空且最多 64 个字符"}
	}
	if note != nil && utf8.RuneCountInString(*note) > 255 {
		fields["note"] = []string{"最多 255 个字符"}
	}
	if len(fields) > 0 {
		return "", "", nil, apierror.Validation(label+"参数不合法", fields)
	}
	return code, name, note, nil
}

func normalizeBOM(code string, planName, note *string, materialID uuid.UUID) (string, *string, *string, error) {
	code, planName, note = strings.TrimSpace(code), trimOptional(planName), trimOptional(note)
	fields := map[string][]string{}
	if utf8.RuneCountInString(code) > 32 {
		fields["code"] = []string{"最多 32 个字符"}
	}
	if materialID == uuid.Nil {
		fields["materialId"] = []string{"必填"}
	}
	if planName != nil && utf8.RuneCountInString(*planName) > 64 {
		fields["planName"] = []string{"最多 64 个字符"}
	}
	if note != nil && utf8.RuneCountInString(*note) > 255 {
		fields["note"] = []string{"最多 255 个字符"}
	}
	if len(fields) > 0 {
		return "", nil, nil, apierror.Validation("BOM参数不合法", fields)
	}
	return code, planName, note, nil
}

func normalizeRoute(input RouteItemInput) (RouteItemInput, error) {
	input.Requirement = trimOptional(input.Requirement)
	fields := map[string][]string{}
	if input.OperationID == uuid.Nil {
		fields["operationId"] = []string{"必填"}
	}
	if input.Requirement != nil && utf8.RuneCountInString(*input.Requirement) > 512 {
		fields["requirement"] = []string{"最多 512 个字符"}
	}
	if len(fields) > 0 {
		return RouteItemInput{}, apierror.Validation("工艺路线行参数不合法", fields)
	}
	return input, nil
}

func validateLine(bomMaterial, material uuid.UUID, quantity decimal.Decimal, lossRate *decimal.Decimal) error {
	fields := map[string][]string{}
	if material == uuid.Nil {
		fields["materialId"] = []string{"必填"}
	} else if material == bomMaterial {
		fields["materialId"] = []string{"行物料不能是 BOM 物料自身"}
	}
	if !quantity.IsPositive() {
		fields["quantity"] = []string{"必须大于 0"}
	}
	if lossRate != nil && lossRate.IsNegative() {
		fields["lossRate"] = []string{"不能为负"}
	}
	if len(fields) > 0 {
		return apierror.Validation("BOM行参数不合法", fields)
	}
	return nil
}

func rejectAnchor(before, requested uuid.UUID, field, message string) error {
	if requested == uuid.Nil || before == requested {
		return nil
	}
	return apierror.Validation("制造主数据锚点不可修改", map[string][]string{field: {message}})
}

func snapshotRoutes(bomID uuid.UUID, items []TemplateItem) []BOMRoute {
	sorted := append([]TemplateItem(nil), items...)
	sort.SliceStable(sorted, func(i, j int) bool {
		if sorted[i].Seq == sorted[j].Seq {
			return sorted[i].ID.String() < sorted[j].ID.String()
		}
		return sorted[i].Seq < sorted[j].Seq
	})
	result := make([]BOMRoute, 0, len(sorted))
	for _, item := range sorted {
		result = append(result, BOMRoute{
			ID: uuid.New(), BOMID: bomID, OperationID: item.OperationID, Seq: item.Seq,
			Requirement: cloneString(item.Requirement), IsOutsourced: item.IsOutsourced,
		})
	}
	return result
}

func trimOptional(value *string) *string {
	if value == nil {
		return nil
	}
	result := strings.TrimSpace(*value)
	if result == "" {
		return nil
	}
	return &result
}

func cloneString(value *string) *string {
	if value == nil {
		return nil
	}
	result := *value
	return &result
}
