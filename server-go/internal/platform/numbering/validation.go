package numbering

import (
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/z1coyan/synie/server/internal/platform/apierror"
)

var dateFormatPattern = regexp.MustCompile(`^(?:YYYY|YY|MM|DD)+$`)

func validateCreate(input *CreateInput, definitions catalog) error {
	input.Resource = strings.TrimSpace(input.Resource)
	input.Name = strings.TrimSpace(input.Name)
	resource, exists := definitions.resource(input.Resource)
	fields := map[string][]string{}
	if !exists {
		fields["resource"] = []string{"未知的绑定资源"}
	}
	if input.Name == "" || utf8.RuneCountInString(input.Name) > 64 {
		fields["name"] = []string{"规则名称必填且最多 64 个字符"}
	}
	if len(input.Segments) == 0 {
		fields["segments"] = []string{"至少需要一个编号段"}
	} else if exists {
		if message := validateSegments(input.Segments, resource); message != "" {
			fields["segments"] = []string{message}
		}
	}
	if len(fields) > 0 {
		return apierror.Validation("编号规则参数不合法", fields)
	}
	return nil
}

func validateSegments(segments []Segment, resource catalogResource) string {
	sequenceCount := 0
	for _, segment := range segments {
		switch segment.Type {
		case "text":
			if segment.Value == nil || *segment.Value == "" {
				return "固定文本段不能为空"
			}
		case "seq":
			sequenceCount++
			padding := 4
			if segment.Padding != nil {
				padding = *segment.Padding
			}
			if padding < 0 || padding > 12 {
				return "序号位数须在 0~12 之间(0=不补零)"
			}
		case "field":
			if segment.Field == nil {
				return "编号段格式不正确"
			}
			field, ok := resource.byPath[*segment.Field]
			if !ok {
				return "编号字段 " + *segment.Field + " 在绑定资源上不存在"
			}
			isDate := field.Type == "date" || field.Type == "datetime"
			if isDate && (segment.Format == nil || !dateFormatPattern.MatchString(*segment.Format)) {
				return "日期字段 " + *segment.Field + " 须选择格式(YYYY/YY/MM/DD 组合)"
			}
			if !isDate && segment.Format != nil {
				return "字段 " + *segment.Field + " 不是日期,不能设格式"
			}
		default:
			return "编号段格式不正确"
		}
	}
	if sequenceCount != 1 {
		return "序号段必须恰好一个"
	}
	return ""
}
