package filterbuild

import (
	"encoding/json"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/meta"
)

type Query struct {
	Limit  int
	Offset int
	Search string
	Sort   *Sort
	Filter map[string]json.RawMessage
}

type Sort struct {
	Column    string
	Direction string
}

type SQL struct {
	Where   string
	OrderBy string
	Args    []any
}

type builder struct {
	resource meta.ResourceMeta
	byAPI    map[string]meta.FieldMeta
	parts    []string
	args     []any
}

var decimalRE = regexp.MustCompile(`^-?[0-9]+(?:\.[0-9]+)?$`)

func Build(resource meta.ResourceMeta, query Query) (SQL, error) {
	b := &builder{
		resource: resource,
		byAPI:    make(map[string]meta.FieldMeta, len(resource.Fields)),
	}
	for _, field := range resource.Fields {
		b.byAPI[field.APIName] = field
	}

	keys := make([]string, 0, len(query.Filter))
	for key := range query.Filter {
		keys = append(keys, key)
	}
	slices.Sort(keys)
	for _, key := range keys {
		field, ok := b.byAPI[key]
		if !ok || !field.Filterable {
			return SQL{}, validation(key, "未知或不可筛选的字段")
		}
		if err := b.addFilter(field, query.Filter[key]); err != nil {
			return SQL{}, err
		}
	}
	if search := strings.TrimSpace(query.Search); search != "" {
		if len(search) > 256 {
			return SQL{}, validation("search", "最多 256 个字符")
		}
		b.addSearch(search)
	}

	orderBy, err := b.orderBy(query.Sort)
	if err != nil {
		return SQL{}, err
	}
	where := ""
	if len(b.parts) > 0 {
		where = " WHERE " + strings.Join(b.parts, " AND ")
	}
	return SQL{Where: where, OrderBy: orderBy, Args: b.args}, nil
}

func (b *builder) addFilter(field meta.FieldMeta, raw json.RawMessage) error {
	var head struct {
		Kind string `json:"kind"`
	}
	if err := json.Unmarshal(raw, &head); err != nil {
		return validation(field.APIName, "筛选条件必须是对象")
	}
	switch head.Kind {
	case "text":
		if field.Type != meta.TypeString {
			return kindMismatch(field, head.Kind)
		}
		var filter struct {
			Kind  string `json:"kind"`
			Op    string `json:"op"`
			Value string `json:"value"`
		}
		if err := strictUnmarshal(raw, &filter); err != nil {
			return validation(field.APIName, "文本筛选格式错误")
		}
		return b.addText(field, filter.Op, filter.Value)
	case "bool":
		if field.Type != meta.TypeBoolean {
			return kindMismatch(field, head.Kind)
		}
		var filter struct {
			Kind string `json:"kind"`
			Eq   *bool  `json:"eq"`
		}
		if err := strictUnmarshal(raw, &filter); err != nil || filter.Eq == nil {
			return validation(field.APIName, "布尔筛选缺少 eq")
		}
		b.parts = append(b.parts, fmt.Sprintf("%s = %s", column(field), b.arg(*filter.Eq)))
		return nil
	case "enum":
		if field.Type != meta.TypeEnum {
			return kindMismatch(field, head.Kind)
		}
		var filter valuesFilter
		if err := strictUnmarshal(raw, &filter); err != nil {
			return validation(field.APIName, "枚举筛选格式错误")
		}
		values, err := enumValues(field, filter.Values)
		if err != nil {
			return err
		}
		if len(values) == 0 {
			return nil
		}
		b.parts = append(b.parts, fmt.Sprintf("%s = ANY(%s::text[])", column(field), b.arg(values)))
		return nil
	case "enumArray":
		if field.Type != meta.TypeEnumArray {
			return kindMismatch(field, head.Kind)
		}
		var filter struct {
			Kind   string   `json:"kind"`
			Op     string   `json:"op"`
			Values []string `json:"values"`
		}
		if err := strictUnmarshal(raw, &filter); err != nil || (filter.Op != "hasAny" && filter.Op != "notHas") {
			return validation(field.APIName, "enumArray op 仅支持 hasAny/notHas")
		}
		values, err := enumValues(field, filter.Values)
		if err != nil {
			return err
		}
		if len(values) == 0 {
			return nil
		}
		expr := fmt.Sprintf("%s && %s::text[]", column(field), b.arg(values))
		if filter.Op == "notHas" {
			expr = "NOT (" + expr + ")"
		}
		b.parts = append(b.parts, expr)
		return nil
	case "number":
		if field.Type != meta.TypeInteger && field.Type != meta.TypeDecimal {
			return kindMismatch(field, head.Kind)
		}
		return b.addNumber(field, raw)
	case "date":
		if field.Type != meta.TypeDate && field.Type != meta.TypeDatetime {
			return kindMismatch(field, head.Kind)
		}
		return b.addDate(field, raw)
	case "fk":
		if field.Type != meta.TypeFK && field.Type != meta.TypeUUID {
			return kindMismatch(field, head.Kind)
		}
		var filter valuesFilter
		if err := strictUnmarshal(raw, &filter); err != nil {
			return validation(field.APIName, "外键筛选格式错误")
		}
		if filter.Op == "isNil" {
			b.parts = append(b.parts, column(field)+" IS NULL")
			return nil
		}
		if filter.Op != "" && filter.Op != "in" {
			return validation(field.APIName, "外键 op 仅支持 in/isNil")
		}
		values, err := uuidValues(field.APIName, filter.Values)
		if err != nil {
			return err
		}
		if len(values) == 0 {
			return nil
		}
		b.parts = append(b.parts, fmt.Sprintf("%s::text = ANY(%s::text[])", column(field), b.arg(values)))
		return nil
	case "polyFk":
		if field.Ref == nil || field.Ref.Discriminator == nil {
			return kindMismatch(field, head.Kind)
		}
		return b.addPolyFK(field, raw)
	default:
		return validation(field.APIName, "未知筛选 kind")
	}
}

type valuesFilter struct {
	Kind   string   `json:"kind"`
	Op     string   `json:"op,omitempty"`
	Values []string `json:"values,omitempty"`
	Labels []string `json:"labels,omitempty"`
}

func (b *builder) addText(field meta.FieldMeta, op, value string) error {
	if value == "" {
		return nil
	}
	col := column(field)
	switch op {
	case "contains", "notContains":
		escaped := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(value)
		expr := fmt.Sprintf("%s ILIKE '%%' || %s || '%%' ESCAPE '\\'", col, b.arg(escaped))
		if op == "notContains" {
			expr = "NOT (" + expr + ")"
		}
		b.parts = append(b.parts, expr)
	case "eq":
		b.parts = append(b.parts, fmt.Sprintf("%s = %s", col, b.arg(value)))
	case "notEq":
		b.parts = append(b.parts, fmt.Sprintf("%s <> %s", col, b.arg(value)))
	default:
		return validation(field.APIName, "文本 op 仅支持 contains/notContains/eq/notEq")
	}
	return nil
}

func (b *builder) addNumber(field meta.FieldMeta, raw json.RawMessage) error {
	var filter struct {
		Kind  string  `json:"kind"`
		Op    string  `json:"op"`
		Value *string `json:"value,omitempty"`
		GTE   *string `json:"gte,omitempty"`
		LTE   *string `json:"lte,omitempty"`
	}
	if err := strictUnmarshal(raw, &filter); err != nil {
		return validation(field.APIName, "数值筛选格式错误")
	}
	col := column(field)
	if filter.Op == "between" {
		if filter.GTE == nil && filter.LTE == nil {
			return nil
		}
		if filter.GTE != nil {
			value, err := parseDecimal(field.APIName, *filter.GTE)
			if err != nil {
				return err
			}
			b.parts = append(b.parts, fmt.Sprintf("%s >= %s::numeric", col, b.arg(value)))
		}
		if filter.LTE != nil {
			value, err := parseDecimal(field.APIName, *filter.LTE)
			if err != nil {
				return err
			}
			b.parts = append(b.parts, fmt.Sprintf("%s <= %s::numeric", col, b.arg(value)))
		}
		return nil
	}
	if filter.Value == nil {
		return validation(field.APIName, "数值筛选缺少 value")
	}
	value, err := parseDecimal(field.APIName, *filter.Value)
	if err != nil {
		return err
	}
	operator := map[string]string{"eq": "=", "gt": ">", "lt": "<", "gte": ">=", "lte": "<="}[filter.Op]
	if operator == "" {
		return validation(field.APIName, "数值 op 仅支持 eq/gt/lt/gte/lte/between")
	}
	b.parts = append(b.parts, fmt.Sprintf("%s %s %s::numeric", col, operator, b.arg(value)))
	return nil
}

func (b *builder) addDate(field meta.FieldMeta, raw json.RawMessage) error {
	var filter struct {
		Kind  string  `json:"kind"`
		Op    string  `json:"op"`
		Value *string `json:"value,omitempty"`
		GTE   *string `json:"gte,omitempty"`
		LTE   *string `json:"lte,omitempty"`
	}
	if err := strictUnmarshal(raw, &filter); err != nil {
		return validation(field.APIName, "日期筛选格式错误")
	}
	col := column(field)
	if filter.Op == "between" {
		if filter.GTE != nil {
			if err := validDate(field.APIName, *filter.GTE); err != nil {
				return err
			}
			b.parts = append(b.parts, fmt.Sprintf("%s >= %s::date", col, b.arg(*filter.GTE)))
		}
		if filter.LTE != nil {
			if err := validDate(field.APIName, *filter.LTE); err != nil {
				return err
			}
			if field.Type == meta.TypeDatetime {
				b.parts = append(b.parts, fmt.Sprintf("%s < (%s::date + INTERVAL '1 day')", col, b.arg(*filter.LTE)))
			} else {
				b.parts = append(b.parts, fmt.Sprintf("%s <= %s::date", col, b.arg(*filter.LTE)))
			}
		}
		return nil
	}
	if filter.Value == nil {
		return validation(field.APIName, "日期筛选缺少 value")
	}
	if err := validDate(field.APIName, *filter.Value); err != nil {
		return err
	}
	switch filter.Op {
	case "eq":
		if field.Type == meta.TypeDatetime {
			arg := b.arg(*filter.Value)
			b.parts = append(b.parts, fmt.Sprintf("(%s >= %s::date AND %s < (%s::date + INTERVAL '1 day'))", col, arg, col, arg))
		} else {
			b.parts = append(b.parts, fmt.Sprintf("%s = %s::date", col, b.arg(*filter.Value)))
		}
	case "before":
		b.parts = append(b.parts, fmt.Sprintf("%s < %s::date", col, b.arg(*filter.Value)))
	case "after":
		if field.Type == meta.TypeDatetime {
			b.parts = append(b.parts, fmt.Sprintf("%s >= (%s::date + INTERVAL '1 day')", col, b.arg(*filter.Value)))
		} else {
			b.parts = append(b.parts, fmt.Sprintf("%s > %s::date", col, b.arg(*filter.Value)))
		}
	default:
		return validation(field.APIName, "日期 op 仅支持 eq/before/after/between")
	}
	return nil
}

func (b *builder) addPolyFK(field meta.FieldMeta, raw json.RawMessage) error {
	var filter struct {
		Kind    string   `json:"kind"`
		Op      string   `json:"op"`
		Variant string   `json:"variant,omitempty"`
		Values  []string `json:"values,omitempty"`
		Labels  []string `json:"labels,omitempty"`
	}
	if err := strictUnmarshal(raw, &filter); err != nil {
		return validation(field.APIName, "多态外键筛选格式错误")
	}
	if filter.Op == "isNil" {
		b.parts = append(b.parts, column(field)+" IS NULL")
		return nil
	}
	if filter.Op != "in" {
		return validation(field.APIName, "polyFk op 仅支持 in/isNil")
	}
	variantOK := false
	for _, variant := range field.Ref.Variants {
		if variant.Value == filter.Variant {
			variantOK = true
			break
		}
	}
	if !variantOK {
		return validation(field.APIName, "未知多态外键变体")
	}
	values, err := uuidValues(field.APIName, filter.Values)
	if err != nil {
		return err
	}
	if len(values) == 0 {
		return nil
	}
	discriminator, ok := b.byAPI[*field.Ref.Discriminator]
	if !ok {
		return validation(field.APIName, "Meta 缺少多态判别字段")
	}
	b.parts = append(b.parts, fmt.Sprintf("(%s = %s AND %s::text = ANY(%s::text[]))",
		column(discriminator), b.arg(strings.ToLower(filter.Variant)), column(field), b.arg(values)))
	return nil
}

func (b *builder) addSearch(search string) {
	parts := make([]string, 0)
	escaped := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(search)
	for _, field := range b.resource.Fields {
		if field.Filterable && field.Type == meta.TypeString {
			parts = append(parts, fmt.Sprintf("%s ILIKE '%%' || %s || '%%' ESCAPE '\\'", column(field), b.arg(escaped)))
		}
	}
	if len(parts) > 0 {
		b.parts = append(b.parts, "("+strings.Join(parts, " OR ")+")")
	}
}

func (b *builder) orderBy(sortValue *Sort) (string, error) {
	if sortValue == nil {
		return "", nil
	}
	field, ok := b.byAPI[sortValue.Column]
	if !ok || !field.Sortable {
		return "", validation("sort.column", "未知或不可排序的字段")
	}
	direction := "ASC"
	switch sortValue.Direction {
	case "ascending":
	case "descending":
		direction = "DESC"
	default:
		return "", validation("sort.direction", "仅支持 ascending/descending")
	}
	return " ORDER BY " + column(field) + " " + direction, nil
}

func (b *builder) arg(value any) string {
	b.args = append(b.args, value)
	return fmt.Sprintf("$%d", len(b.args))
}

func column(field meta.FieldMeta) string {
	return `"` + field.DBColumn + `"`
}

func enumValues(field meta.FieldMeta, values []string) ([]string, error) {
	allowed := make(map[string]struct{}, len(field.EnumOptions))
	for _, option := range field.EnumOptions {
		allowed[option.Value] = struct{}{}
	}
	result := make([]string, len(values))
	for i, value := range values {
		if _, ok := allowed[value]; !ok {
			return nil, validation(field.APIName, "包含未知枚举值")
		}
		// Ash enum wire 值为大写，PostgreSQL 存储值为 lowercase；校验在 wire
		// 值上完成后统一转存储值，供 enum 与 enumArray 共用。
		result[i] = strings.ToLower(value)
	}
	return result, nil
}

func uuidValues(field string, values []string) ([]string, error) {
	for _, value := range values {
		if _, err := uuid.Parse(value); err != nil {
			return nil, validation(field, "包含无效 UUID")
		}
	}
	return slices.Clone(values), nil
}

func parseDecimal(field, value string) (string, error) {
	if !decimalRE.MatchString(value) {
		return "", validation(field, "数值必须是十进制字符串")
	}
	parsed, err := decimal.NewFromString(value)
	if err != nil {
		return "", validation(field, "数值无效")
	}
	return parsed.String(), nil
}

func validDate(field, value string) error {
	if _, err := time.Parse("2006-01-02", value); err != nil {
		return validation(field, "日期必须是 YYYY-MM-DD")
	}
	return nil
}

func strictUnmarshal(raw json.RawMessage, target any) error {
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.DisallowUnknownFields()
	return decoder.Decode(target)
}

func validation(field, message string) error {
	return apierror.Validation("筛选条件错误", map[string][]string{field: {message}})
}

func kindMismatch(field meta.FieldMeta, kind string) error {
	return validation(field.APIName, fmt.Sprintf("kind %s 与字段类型 %s 不匹配", kind, field.Type))
}
