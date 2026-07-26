package company

import (
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestValidateCreateNormalizesAndAcceptsCompany(t *testing.T) {
	t.Parallel()
	input := CreateInput{
		Code: " ab ", Name: " 集团总部 ", ShortName: " 总部 ", BaseCurrencyID: uuid.New(),
	}
	if err := validateCreate(&input); err != nil {
		t.Fatal(err)
	}
	if input.Code != "ab" || input.Name != "集团总部" || input.ShortName != "总部" {
		t.Fatalf("input 未归一化: %#v", input)
	}
}

func TestValidateCreateRejectsBusinessConstraints(t *testing.T) {
	t.Parallel()
	input := CreateInput{Code: "A1", Name: strings.Repeat("公", 129), ShortName: "", BaseCurrencyID: uuid.Nil}
	if err := validateCreate(&input); err == nil {
		t.Fatal("expected validation error")
	}
}

func TestValidateUpdateAllowsExplicitParentClear(t *testing.T) {
	t.Parallel()
	var parent *uuid.UUID
	input := UpdateInput{ParentID: &parent}
	if err := validateUpdate(&input); err != nil {
		t.Fatal(err)
	}
	if input.ParentID == nil || *input.ParentID != nil {
		t.Fatalf("explicit null parent lost: %#v", input.ParentID)
	}
}
