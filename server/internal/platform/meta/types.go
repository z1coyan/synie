package meta

type FieldType string

const (
	TypeString    FieldType = "string"
	TypeInteger   FieldType = "integer"
	TypeDecimal   FieldType = "decimal"
	TypeBoolean   FieldType = "boolean"
	TypeDate      FieldType = "date"
	TypeDatetime  FieldType = "datetime"
	TypeEnum      FieldType = "enum"
	TypeEnumArray FieldType = "enumArray"
	TypeUUID      FieldType = "uuid"
	TypeJSON      FieldType = "json"
	TypeFK        FieldType = "fk"
)

type ResourceMeta struct {
	Name             string
	PermissionPrefix string
	PermissionLabel  string
	// ReadPermissionsAny 用于没有独立权限点的只读投影视图：Actor
	// 持有任一完整权限码即可读取，且该资源不向权限目录新增虚假分组。
	ReadPermissionsAny []string
	Table              string
	Fields             []FieldMeta
	Actions            []ActionMeta
	Form               *FormMetaDTO
	Print              bool
	Audit              AuditMeta
	DestroyMutation    *string
}

type AuditMeta struct {
	Enabled         bool
	SensitiveFields []string
}

type FieldMeta struct {
	Name         string
	APIName      string
	DBColumn     string
	Type         FieldType
	Label        string
	Required     bool
	Readonly     bool
	CreateOnly   bool
	Sensitive    bool
	EnumOptions  []EnumOption
	Ref          *GridColumnRef
	Filterable   bool
	Sortable     bool
	DecimalScale *int
}

type ActionMeta struct {
	Key              string
	Label            string
	Scope            string
	PermissionAction string
	Mutation         string
	IsDanger         bool
	HTTP             *HTTPAction
	ConfirmKind      string
}

type HTTPAction struct {
	Method string `json:"method"`
	Path   string `json:"path"`
}

type ResourceMetaDocument struct {
	Name string       `json:"name"`
	Grid GridMetaDTO  `json:"grid"`
	Form *FormMetaDTO `json:"form,omitempty"`
}

type GridMetaDTO struct {
	Columns         []GridColumnDTO `json:"columns"`
	Capabilities    []string        `json:"capabilities"`
	ExtendedActions []GridActionDTO `json:"extendedActions"`
	DestroyMutation *string         `json:"destroyMutation"`
}

type GridColumnDTO struct {
	Name        string         `json:"name"`
	Type        string         `json:"type"`
	Label       string         `json:"label"`
	Sortable    bool           `json:"sortable"`
	Filterable  bool           `json:"filterable"`
	EnumOptions []EnumOption   `json:"enumOptions"`
	Ref         *GridColumnRef `json:"ref"`
}

type EnumOption struct {
	Value string `json:"value"`
	Label string `json:"label"`
}

type GridColumnRef struct {
	Resource          *string                `json:"resource,omitempty"`
	Relation          *string                `json:"relation,omitempty"`
	LabelField        *string                `json:"labelField,omitempty"`
	Discriminator     *string                `json:"discriminator,omitempty"`
	DiscriminatorType *string                `json:"discriminatorType,omitempty"`
	Variants          []GridColumnRefVariant `json:"variants,omitempty"`
}

type GridColumnRefVariant struct {
	Value      string `json:"value"`
	Resource   string `json:"resource"`
	LabelField string `json:"labelField"`
	Label      string `json:"label"`
}

type GridActionDTO struct {
	Key         string      `json:"key"`
	Label       string      `json:"label"`
	Scope       string      `json:"scope"`
	Mutation    string      `json:"mutation"`
	IsDanger    bool        `json:"isDanger"`
	HTTP        *HTTPAction `json:"http,omitempty"`
	ConfirmKind string      `json:"confirmKind,omitempty"`
}

type FormMetaDTO struct {
	Exclude  []string                  `json:"exclude,omitempty"`
	Fields   map[string]map[string]any `json:"fields,omitempty"`
	Sections []map[string]any          `json:"sections,omitempty"`
	Tabs     []map[string]any          `json:"tabs,omitempty"`
}

type PermissionGroup struct {
	Prefix  string   `json:"prefix"`
	Label   string   `json:"label"`
	Actions []string `json:"actions"`
}

type ResourceSummary struct {
	Name             string `json:"name"`
	PermissionPrefix string `json:"permissionPrefix"`
	PermissionLabel  string `json:"permissionLabel"`
}
