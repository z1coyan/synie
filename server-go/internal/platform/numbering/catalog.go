package numbering

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"regexp"
	"slices"
)

//go:embed numberables.json
var numberablesJSON []byte

var catalogIdentifier = regexp.MustCompile(`^[a-z_][a-z0-9_]*$`)

type catalog struct {
	resources []catalogResource
	byPrefix  map[string]catalogResource
}

func loadCatalog() catalog {
	var resources []catalogResource
	if err := json.Unmarshal(numberablesJSON, &resources); err != nil {
		panic(fmt.Sprintf("解析编号字段目录: %v", err))
	}
	byPrefix := make(map[string]catalogResource, len(resources))
	for i := range resources {
		resource := &resources[i]
		if resource.Prefix == "" || resource.Grid == "" {
			panic("编号字段目录存在空资源")
		}
		resource.byPath = make(map[string]catalogField, len(resource.Fields))
		for _, field := range resource.Fields {
			if field.Path == "" || field.Label == "" || field.Type == "" ||
				!catalogIdentifier.MatchString(field.SourceField) {
				panic(fmt.Sprintf("编号字段目录存在非法字段: %#v", field))
			}
			if field.Lookup != nil &&
				(!catalogIdentifier.MatchString(field.Lookup.Table) ||
					!catalogIdentifier.MatchString(field.Lookup.ValueColumn)) {
				panic(fmt.Sprintf("编号字段目录存在非法查询列: %#v", field))
			}
			if _, exists := resource.byPath[field.Path]; exists {
				panic(fmt.Sprintf("编号字段目录重复路径: %s/%s", resource.Prefix, field.Path))
			}
			resource.byPath[field.Path] = field
		}
		if _, exists := byPrefix[resource.Prefix]; exists {
			panic("编号字段目录重复资源: " + resource.Prefix)
		}
		byPrefix[resource.Prefix] = *resource
	}
	return catalog{resources: resources, byPrefix: byPrefix}
}

func (c catalog) PublicResources() []NumberableResource {
	result := make([]NumberableResource, 0, len(c.resources))
	for _, resource := range c.resources {
		fields := make([]NumberableField, 0, len(resource.Fields))
		for _, field := range resource.Fields {
			fields = append(fields, NumberableField{Path: field.Path, Label: field.Label, Type: field.Type})
		}
		result = append(result, NumberableResource{
			Prefix: resource.Prefix, Grid: resource.Grid, Fields: fields,
		})
	}
	return result
}

func (c catalog) resource(prefix string) (catalogResource, bool) {
	resource, ok := c.byPrefix[prefix]
	if !ok {
		return catalogResource{}, false
	}
	resource.Fields = slices.Clone(resource.Fields)
	return resource, true
}
