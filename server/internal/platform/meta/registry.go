package meta

import (
	"fmt"
	"regexp"
	"slices"
	"sort"
	"sync"

	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

var identifierRE = regexp.MustCompile(`^[a-z_][a-z0-9_]*$`)

type Registry struct {
	mu               sync.RWMutex
	resources        map[string]ResourceMeta
	permissionLabels map[string]string
}

func NewRegistry() *Registry {
	return &Registry{
		resources:        make(map[string]ResourceMeta),
		permissionLabels: make(map[string]string),
	}
}

func (r *Registry) MustRegister(resource ResourceMeta) {
	if err := validate(resource); err != nil {
		panic(err)
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.resources[resource.Name]; exists {
		panic("重复 Meta 资源: " + resource.Name)
	}
	if previous, exists := r.permissionLabels[resource.PermissionPrefix]; exists && previous != resource.PermissionLabel {
		panic(fmt.Sprintf("共享权限前缀 %s 的标签不一致: %s / %s", resource.PermissionPrefix, previous, resource.PermissionLabel))
	}
	resource.Fields = slices.Clone(resource.Fields)
	resource.Actions = slices.Clone(resource.Actions)
	resource.ReadPermissionsAny = slices.Clone(resource.ReadPermissionsAny)
	r.resources[resource.Name] = resource
	r.permissionLabels[resource.PermissionPrefix] = resource.PermissionLabel
}

func (r *Registry) Get(name string) (ResourceMeta, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	resource, ok := r.resources[name]
	return resource, ok
}

func (r *Registry) BuildDocument(name string, actor *authz.Actor) (ResourceMetaDocument, error) {
	resource, ok := r.Get(name)
	if !ok {
		return ResourceMetaDocument{}, apierror.New(apierror.CodeNotFound, "未知的 Meta 资源")
	}
	if !canReadResource(resource, actor) {
		return ResourceMetaDocument{}, apierror.New(apierror.CodeForbidden, "无权限访问该资源")
	}

	columns := make([]GridColumnDTO, 0, len(resource.Fields))
	for _, field := range resource.Fields {
		if field.Sensitive {
			continue
		}
		columnType := string(field.Type)
		if field.Type == TypeUUID {
			columnType = string(TypeString)
		}
		ref := r.visibleRef(field.Ref, actor)
		sortable := field.Sortable
		filterable := field.Filterable
		if ref != nil {
			columnType = string(TypeFK)
		} else if field.Ref != nil {
			// 与旧 GridMeta 契约一致：无权读取引用目标时只暴露原始 ID，
			// 不允许沿不可见关系筛选，但允许按物理 ID 排序。
			columnType = string(TypeString)
			sortable = true
			filterable = false
		}
		var options []EnumOption
		if field.EnumOptions != nil {
			options = slices.Clone(field.EnumOptions)
		}
		columns = append(columns, GridColumnDTO{
			Name:        field.APIName,
			Type:        columnType,
			Label:       field.Label,
			Sortable:    sortable,
			Filterable:  filterable,
			EnumOptions: options,
			Ref:         ref,
		})
	}

	capabilities := make([]string, 0, len(resource.Actions))
	capabilitySet := make(map[string]struct{}, len(resource.Actions))
	extended := make([]GridActionDTO, 0)
	for _, action := range resource.Actions {
		permissionAction := action.PermissionAction
		if permissionAction == "" {
			permissionAction = action.Key
		}
		if actor.HasPermission(resource.PermissionPrefix+":"+permissionAction) && permissionAction != "read" {
			if _, exists := capabilitySet[permissionAction]; !exists {
				capabilitySet[permissionAction] = struct{}{}
				capabilities = append(capabilities, permissionAction)
			}
		}
		switch action.Key {
		case "read", "create", "update", "delete", "print", "import", "export",
			"batch_delete", "batch_update", "batch_print":
			continue
		default:
			extended = append(extended, GridActionDTO{
				Key:         action.Key,
				Label:       action.Label,
				Scope:       action.Scope,
				Mutation:    action.Mutation,
				IsDanger:    action.IsDanger,
				HTTP:        action.HTTP,
				ConfirmKind: action.ConfirmKind,
			})
		}
	}
	return ResourceMetaDocument{
		Name: resource.Name,
		Grid: GridMetaDTO{
			Columns:         columns,
			Capabilities:    capabilities,
			ExtendedActions: extended,
			DestroyMutation: resource.DestroyMutation,
		},
		Form: resource.Form,
	}, nil
}

func (r *Registry) visibleRef(ref *GridColumnRef, actor *authz.Actor) *GridColumnRef {
	if ref == nil || actor.SuperAdmin {
		return ref
	}
	if ref.Resource != nil {
		target, ok := r.Get(*ref.Resource)
		if !ok || !canReadResource(target, actor) {
			return nil
		}
		return ref
	}
	if len(ref.Variants) == 0 {
		return nil
	}
	variants := make([]GridColumnRefVariant, 0, len(ref.Variants))
	for _, variant := range ref.Variants {
		target, ok := r.Get(variant.Resource)
		if ok && canReadResource(target, actor) {
			variants = append(variants, variant)
		}
	}
	if len(variants) == 0 {
		return nil
	}
	clone := *ref
	clone.Variants = variants
	return &clone
}

func (r *Registry) Summaries(actor *authz.Actor) []ResourceSummary {
	r.mu.RLock()
	defer r.mu.RUnlock()
	result := make([]ResourceSummary, 0, len(r.resources))
	for _, resource := range r.resources {
		if !canReadResource(resource, actor) {
			continue
		}
		result = append(result, ResourceSummary{
			Name:             resource.Name,
			PermissionPrefix: resource.PermissionPrefix,
			PermissionLabel:  resource.PermissionLabel,
		})
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Name < result[j].Name })
	return result
}

func (r *Registry) PermissionCatalog() []PermissionGroup {
	r.mu.RLock()
	defer r.mu.RUnlock()
	groups := make(map[string]map[string]struct{}, len(r.permissionLabels))
	for _, resource := range r.resources {
		if len(resource.ReadPermissionsAny) > 0 {
			continue
		}
		actions, ok := groups[resource.PermissionPrefix]
		if !ok {
			actions = make(map[string]struct{})
			groups[resource.PermissionPrefix] = actions
		}
		for _, action := range resource.Actions {
			permissionAction := action.PermissionAction
			if permissionAction == "" {
				permissionAction = action.Key
			}
			actions[permissionAction] = struct{}{}
		}
	}
	result := make([]PermissionGroup, 0, len(groups))
	for prefix, actionSet := range groups {
		actions := make([]string, 0, len(actionSet))
		for action := range actionSet {
			actions = append(actions, action)
		}
		sort.Strings(actions)
		result = append(result, PermissionGroup{Prefix: prefix, Label: r.permissionLabels[prefix], Actions: actions})
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Prefix < result[j].Prefix })
	return result
}

func canReadResource(resource ResourceMeta, actor *authz.Actor) bool {
	if actor == nil {
		return false
	}
	if len(resource.ReadPermissionsAny) == 0 {
		return actor.HasPermission(resource.PermissionPrefix + ":read")
	}
	for _, permission := range resource.ReadPermissionsAny {
		if actor.HasPermission(permission) {
			return true
		}
	}
	return false
}

func validate(resource ResourceMeta) error {
	if resource.Name == "" || resource.PermissionPrefix == "" || resource.PermissionLabel == "" {
		return fmt.Errorf("Meta 资源 name/permissionPrefix/permissionLabel 必填: %#v", resource)
	}
	if !identifierRE.MatchString(resource.Table) {
		return fmt.Errorf("Meta 资源 %s 的表名非法: %q", resource.Name, resource.Table)
	}
	fields := make(map[string]struct{}, len(resource.Fields))
	for _, field := range resource.Fields {
		if field.Name == "" || field.APIName == "" || field.DBColumn == "" || field.Label == "" {
			return fmt.Errorf("Meta 资源 %s 存在不完整字段: %#v", resource.Name, field)
		}
		if !identifierRE.MatchString(field.DBColumn) {
			return fmt.Errorf("Meta 资源 %s 的列名非法: %q", resource.Name, field.DBColumn)
		}
		if _, exists := fields[field.APIName]; exists {
			return fmt.Errorf("Meta 资源 %s 重复字段: %s", resource.Name, field.APIName)
		}
		fields[field.APIName] = struct{}{}
	}
	actions := make(map[string]struct{}, len(resource.Actions))
	for _, action := range resource.Actions {
		if action.Key == "" {
			return fmt.Errorf("Meta 资源 %s 存在空动作", resource.Name)
		}
		if _, exists := actions[action.Key]; exists {
			return fmt.Errorf("Meta 资源 %s 重复动作: %s", resource.Name, action.Key)
		}
		actions[action.Key] = struct{}{}
	}
	return nil
}
