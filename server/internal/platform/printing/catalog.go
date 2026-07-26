package printing

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/z1coyan/synie/server/internal/platform/apierror"
)

//go:embed field_catalog.json
var capturedFieldCatalog []byte

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

// FieldCatalog is the stable printing-facing interface over the mechanically
// captured legacy catalog. Callers do not depend on how definitions are derived.
type FieldCatalog struct {
	byResource map[string]ResourceCatalog
	resources  []string
}

func NewFieldCatalog() *FieldCatalog {
	var definitions []ResourceCatalog
	if err := json.Unmarshal(capturedFieldCatalog, &definitions); err != nil {
		panic(fmt.Sprintf("decode embedded print field catalog: %v", err))
	}
	catalog := &FieldCatalog{
		byResource: make(map[string]ResourceCatalog, len(definitions)),
		resources:  make([]string, 0, len(definitions)),
	}
	for _, definition := range definitions {
		catalog.byResource[definition.Resource] = definition
		catalog.resources = append(catalog.resources, definition.Resource)
	}
	sort.Strings(catalog.resources)
	return catalog
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
