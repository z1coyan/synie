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
	// PrintHead 标记该资源是其权限前缀的打印字段目录头资源。前缀下只有一个
	// 候选资源（非 ReadPermissionsAny 投影视图）时可省略，由派生自动认定。
	PrintHead bool
	// PrintLoops 声明打印循环区（子表）。循环目标的嵌套循环由目标资源自身的
	// PrintLoops 派生，不重复描述。
	PrintLoops      []PrintLoopMeta
	Audit           AuditMeta
	DestroyMutation *string
}

// PrintLoopMeta 是一个打印循环区声明：占位符 {Name.field} 逐行展开目标资源。
type PrintLoopMeta struct {
	Name     string // 占位符循环区名（如 "items"）
	Resource string // 循环目标 Meta 资源名（如 "salOrderItems"）
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
	// Calculated 标记计算/投影字段（非物理列）：打印字段目录做一层关联展开时
	// 跳过目标的此类字段，资源自身字段面仍包含。
	Calculated bool
	// PrintOnly 标记仅打印字段目录可见的字段（如 has_children）：不进入
	// Grid 文档，也不参与筛选/排序。
	PrintOnly bool
	// PrintRawID 标记多态外键在打印目录中只暴露原始 ID 列（如子表的
	// party_id），不做 "party.name" 式标签展开。
	PrintRawID bool
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
