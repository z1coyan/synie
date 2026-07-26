package currency

import (
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/z1coyan/synie/server/internal/platform/apierror"
)

var isoCodeRE = regexp.MustCompile(`^[A-Z]{3}$`)

func validateCreate(input *CreateInput) error {
	input.Name = strings.TrimSpace(input.Name)
	input.ISOCode = strings.TrimSpace(input.ISOCode)
	fields := map[string][]string{}
	validateName(input.Name, fields)
	if !isoCodeRE.MatchString(input.ISOCode) {
		fields["isoCode"] = []string{"必须是 ISO 4217 三位大写字母编码"}
	}
	if input.Symbol != nil {
		value := strings.TrimSpace(*input.Symbol)
		input.Symbol = &value
		validateSymbol(value, fields)
	}
	if len(fields) > 0 {
		return apierror.Validation("币种参数不合法", fields)
	}
	return nil
}

func validateUpdate(input *UpdateInput) error {
	fields := map[string][]string{}
	if input.Name != nil {
		value := strings.TrimSpace(*input.Name)
		input.Name = &value
		validateName(value, fields)
	}
	if input.Symbol.Set && input.Symbol.Value != nil {
		value := strings.TrimSpace(*input.Symbol.Value)
		input.Symbol.Value = &value
		validateSymbol(value, fields)
	}
	if len(fields) > 0 {
		return apierror.Validation("币种参数不合法", fields)
	}
	return nil
}

func validateName(value string, fields map[string][]string) {
	if value == "" {
		fields["name"] = []string{"不能为空"}
	} else if utf8.RuneCountInString(value) > 64 {
		fields["name"] = []string{"最多 64 个字符"}
	}
}

func validateSymbol(value string, fields map[string][]string) {
	if utf8.RuneCountInString(value) > 8 {
		fields["symbol"] = []string{"最多 8 个字符"}
	}
}
