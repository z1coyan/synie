package company

import (
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/z1coyan/synie/server/internal/platform/apierror"
)

var codeRE = regexp.MustCompile(`^[A-Za-z]{2}$`)

func validateCreate(input *CreateInput) error {
	input.Code = strings.TrimSpace(input.Code)
	input.Name = strings.TrimSpace(input.Name)
	input.ShortName = strings.TrimSpace(input.ShortName)
	fields := map[string][]string{}
	if !codeRE.MatchString(input.Code) {
		fields["code"] = []string{"必须是恰好两位英文字母"}
	}
	validateName(input.Name, "name", 128, fields)
	validateName(input.ShortName, "shortName", 32, fields)
	if input.BaseCurrencyID.String() == "00000000-0000-0000-0000-000000000000" {
		fields["baseCurrencyId"] = []string{"不能为空"}
	}
	if len(fields) > 0 {
		return apierror.Validation("公司参数不合法", fields)
	}
	return nil
}

func validateUpdate(input *UpdateInput) error {
	fields := map[string][]string{}
	if input.Name != nil {
		value := strings.TrimSpace(*input.Name)
		input.Name = &value
		validateName(value, "name", 128, fields)
	}
	if input.ShortName != nil {
		value := strings.TrimSpace(*input.ShortName)
		input.ShortName = &value
		validateName(value, "shortName", 32, fields)
	}
	if input.BaseCurrencyID != nil && input.BaseCurrencyID.String() == "00000000-0000-0000-0000-000000000000" {
		fields["baseCurrencyId"] = []string{"不能为空"}
	}
	if len(fields) > 0 {
		return apierror.Validation("公司参数不合法", fields)
	}
	return nil
}

func validateName(value, field string, max int, fields map[string][]string) {
	if value == "" {
		fields[field] = []string{"不能为空"}
	} else if utf8.RuneCountInString(value) > max {
		fields[field] = []string{"最多 " + strconv.Itoa(max) + " 个字符"}
	}
}
