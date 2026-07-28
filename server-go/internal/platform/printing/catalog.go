package printing

import (
	"fmt"
	"sort"
	"strings"

	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/meta"
)

type Field struct {
	Name  string `json:"name"`
	Label string `json:"label"`
}

type Loop struct {
	Name        string   `json:"name"`
	Label       string   `json:"label"`
	Fields      []Field  `json:"fields"`
	NestedLoops []string `json:"nestedLoops,omitempty"`
}

type ResourceCatalog struct {
	Resource string  `json:"resource"`
	Fields   []Field `json:"fields"`
	Loops    []Loop  `json:"loops"`
}

type PlaceholderSet struct {
	Fields []string            `json:"fields"`
	Nested map[string][]string `json:"nested"`
}

// FieldCatalog is the stable printing-facing interface over the field catalog
// derived from meta.Registry. Callers do not depend on how definitions are derived.
type FieldCatalog struct {
	byResource map[string]ResourceCatalog
	resources  []string
}

// NewFieldCatalog 从 meta.Registry 派生打印字段目录（单一事实源，对齐旧
// Elixir/Ash 反射口径）：
//   - 目录资源 = 权限前缀的头资源（PrintHead 显式标记；前缀下只有一个非投影
//     候选时自动认定；ReadPermissionsAny 投影视图不参与）；
//   - 头字段 = 自身标量（含计算/投影字段，剔除 id/时间戳/敏感字段/*_id 外键列）
//   - belongs_to 一层展开（relation.目标标量，目标侧跳过计算字段）
//   - 封闭枚举多态的 relation.labelField（如 party.name）；
//   - 循环区 = 头资源 PrintLoops 声明，字段口径与头字段一致，嵌套循环取循环
//     目标自身的 PrintLoops；PrintRawID 多态外键（如子表 party_id）只暴露
//     原始 ID 列；开放字符串多态（voucher）从不展开。
func NewFieldCatalog(registry *meta.Registry) *FieldCatalog {
	if registry == nil {
		panic("打印字段目录需要 meta.Registry")
	}
	catalog := &FieldCatalog{byResource: make(map[string]ResourceCatalog)}
	for _, head := range printHeads(registry) {
		definition := ResourceCatalog{
			Resource: head.PermissionPrefix,
			Fields:   deriveFields(registry, head),
		}
		for _, declared := range head.PrintLoops {
			target, ok := registry.Get(declared.Resource)
			if !ok {
				panic(fmt.Sprintf("打印循环区 %s.%s 指向未知 Meta 资源: %s",
					head.Name, declared.Name, declared.Resource))
			}
			loop := Loop{
				Name:   declared.Name,
				Label:  declared.Name,
				Fields: deriveFields(registry, target),
			}
			for _, nested := range target.PrintLoops {
				loop.NestedLoops = append(loop.NestedLoops, nested.Name)
			}
			sort.Strings(loop.NestedLoops)
			definition.Loops = append(definition.Loops, loop)
		}
		sort.Slice(definition.Loops, func(i, j int) bool {
			return definition.Loops[i].Name < definition.Loops[j].Name
		})
		catalog.byResource[definition.Resource] = definition
		catalog.resources = append(catalog.resources, definition.Resource)
	}
	sort.Strings(catalog.resources)
	return catalog
}

// printHeads 选出每个权限前缀的打印头资源。
func printHeads(registry *meta.Registry) []meta.ResourceMeta {
	candidates := make(map[string][]meta.ResourceMeta)
	marked := make(map[string][]meta.ResourceMeta)
	for _, resource := range registry.Resources() {
		if len(resource.ReadPermissionsAny) > 0 {
			continue
		}
		candidates[resource.PermissionPrefix] = append(candidates[resource.PermissionPrefix], resource)
		if resource.PrintHead {
			marked[resource.PermissionPrefix] = append(marked[resource.PermissionPrefix], resource)
		}
	}
	heads := make([]meta.ResourceMeta, 0, len(candidates))
	for prefix, group := range candidates {
		explicit := marked[prefix]
		switch {
		case len(explicit) > 1:
			panic("权限前缀 " + prefix + " 存在多个打印头资源")
		case len(explicit) == 1:
			heads = append(heads, explicit[0])
		case len(group) == 1:
			heads = append(heads, group[0])
		default:
			names := make([]string, 0, len(group))
			for _, resource := range group {
				names = append(names, resource.Name)
			}
			panic(fmt.Sprintf("权限前缀 %s 的打印头资源不明确（%s），请用 PrintHead 标记",
				prefix, strings.Join(names, ", ")))
		}
	}
	return heads
}

var technicalFields = map[string]struct{}{"id": {}, "inserted_at": {}, "updated_at": {}}

// deriveFields 派生单资源的可打印字段面（头字段与循环区字段同口径）。
func deriveFields(registry *meta.Registry, resource meta.ResourceMeta) []Field {
	names := make(map[string]struct{})
	for _, field := range resource.Fields {
		if _, technical := technicalFields[field.Name]; technical || field.Sensitive {
			continue
		}
		if field.Ref != nil {
			deriveRefFields(registry, resource, field, names)
			continue
		}
		if field.Type == meta.TypeFK || strings.HasSuffix(field.Name, "_id") {
			continue
		}
		names[field.Name] = struct{}{}
	}
	return sortedFields(names)
}

func deriveRefFields(
	registry *meta.Registry,
	resource meta.ResourceMeta,
	field meta.FieldMeta,
	names map[string]struct{},
) {
	ref := field.Ref
	if len(ref.Variants) > 0 {
		// 封闭枚举多态（如 party）：展开 relation.labelField；PrintRawID
		// （如子表 party_id）只暴露原始 ID 列。开放字符串多态（voucher）
		// 字段面不固定，从不展开。
		if ref.DiscriminatorType == nil || *ref.DiscriminatorType != "enum" {
			return
		}
		if field.PrintRawID {
			names[field.Name] = struct{}{}
			return
		}
		for _, variant := range ref.Variants {
			names[refPrefix(field)+"."+variant.LabelField] = struct{}{}
		}
		return
	}
	if ref.Resource == nil {
		return
	}
	target, ok := registry.Get(*ref.Resource)
	if !ok {
		panic(fmt.Sprintf("Meta 资源 %s 字段 %s 的打印关联指向未知资源: %s",
			resource.Name, field.Name, *ref.Resource))
	}
	prefix := refPrefix(field)
	for _, targetField := range target.Fields {
		if _, technical := technicalFields[targetField.Name]; technical ||
			targetField.Sensitive || targetField.Calculated {
			continue
		}
		if targetField.Ref != nil || targetField.Type == meta.TypeFK ||
			strings.HasSuffix(targetField.Name, "_id") {
			continue
		}
		names[prefix+"."+targetField.Name] = struct{}{}
	}
}

// refPrefix 计算关联展开路径前缀：优先 Relation 名（camelCase 转 snake_case），
// 否则取外键列去掉 _id 后缀。
func refPrefix(field meta.FieldMeta) string {
	if field.Ref.Relation != nil && *field.Ref.Relation != "" {
		return snakeCase(*field.Ref.Relation)
	}
	return strings.TrimSuffix(field.DBColumn, "_id")
}

func snakeCase(value string) string {
	var result strings.Builder
	for index, r := range value {
		if r >= 'A' && r <= 'Z' {
			if index > 0 {
				result.WriteByte('_')
			}
			result.WriteRune(r + ('a' - 'A'))
			continue
		}
		result.WriteRune(r)
	}
	return result.String()
}

func sortedFields(names map[string]struct{}) []Field {
	result := make([]Field, 0, len(names))
	for name := range names {
		result = append(result, Field{Name: name, Label: name})
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Name < result[j].Name })
	return result
}

func (c *FieldCatalog) Resources() []string {
	return append([]string(nil), c.resources...)
}

func (c *FieldCatalog) Get(resource string) (ResourceCatalog, bool) {
	definition, ok := c.byResource[resource]
	if !ok {
		return ResourceCatalog{}, false
	}
	return cloneResourceCatalog(definition), true
}

func (c *FieldCatalog) ValidatePlaceholders(resource string, placeholders PlaceholderSet) error {
	definition, ok := c.byResource[resource]
	if !ok {
		return apierror.Validation(
			"不支持的资源类型 "+resource,
			map[string][]string{"resource": {"不在打印字段目录中"}},
		)
	}
	head := fieldSet(definition.Fields)
	loops := make(map[string]Loop, len(definition.Loops))
	for _, loop := range definition.Loops {
		loops[loop.Name] = loop
	}

	unknownHead := make([]string, 0)
	for _, name := range placeholders.Fields {
		if _, exists := head[name]; !exists {
			unknownHead = append(unknownHead, name)
		}
	}
	unknownLoop := make([]string, 0)
	deep := make([]string, 0)
	nestedLoop := make([]string, 0)
	for prefix, suffixes := range placeholders.Nested {
		if loop, exists := loops[prefix]; exists {
			allowed := fieldSet(loop.Fields)
			allowed["_seq"] = struct{}{}
			nestedNames := make(map[string]struct{}, len(loop.NestedLoops))
			for _, name := range loop.NestedLoops {
				nestedNames[name] = struct{}{}
			}
			for _, suffix := range suffixes {
				first := firstSegment(suffix)
				if _, nested := nestedNames[first]; nested {
					nestedLoop = append(nestedLoop, prefix+"."+first)
				} else if _, allowedField := allowed[suffix]; !allowedField {
					unknownLoop = append(unknownLoop, prefix+"."+suffix)
				}
			}
			continue
		}
		for _, suffix := range suffixes {
			full := prefix + "." + suffix
			if strings.Contains(suffix, ".") {
				deep = append(deep, full)
			} else if _, exists := head[full]; !exists {
				unknownHead = append(unknownHead, full)
			}
		}
	}

	parts := make([]string, 0, 4)
	parts = appendErrorPart(parts, "未知头字段", unknownHead)
	parts = appendErrorPart(parts, "未知循环区字段", unknownLoop)
	parts = appendErrorPart(parts, "关联路径只支持一层", deep)
	parts = appendErrorPart(parts, "不支持嵌套循环", nestedLoop)
	if len(parts) == 0 {
		return nil
	}
	message := strings.Join(parts, "；")
	return apierror.Validation(message, map[string][]string{"fileId": {message}})
}

func cloneResourceCatalog(value ResourceCatalog) ResourceCatalog {
	result := value
	result.Fields = append([]Field(nil), value.Fields...)
	result.Loops = make([]Loop, len(value.Loops))
	for index, loop := range value.Loops {
		result.Loops[index] = loop
		result.Loops[index].Fields = append([]Field(nil), loop.Fields...)
		result.Loops[index].NestedLoops = append([]string(nil), loop.NestedLoops...)
	}
	return result
}

func fieldSet(fields []Field) map[string]struct{} {
	result := make(map[string]struct{}, len(fields))
	for _, field := range fields {
		result[field.Name] = struct{}{}
	}
	return result
}

func firstSegment(value string) string {
	if index := strings.IndexByte(value, '.'); index >= 0 {
		return value[:index]
	}
	return value
}

func appendErrorPart(parts []string, label string, names []string) []string {
	if len(names) == 0 {
		return parts
	}
	names = uniqueSorted(names)
	return append(parts, label+": "+strings.Join(names, ", "))
}

func uniqueSorted(values []string) []string {
	set := make(map[string]struct{}, len(values))
	for _, value := range values {
		set[value] = struct{}{}
	}
	result := make([]string, 0, len(set))
	for value := range set {
		result = append(result, value)
	}
	sort.Strings(result)
	return result
}
