package setup

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

func TestCompleteRejectsUnsupportedLanguageBeforeDatabase(t *testing.T) {
	service := &Service{}
	err := service.Complete(context.Background(), &authz.Actor{UserID: uuid.New(), SuperAdmin: true}, "ja-JP", false)
	var appErr *apierror.Error
	if !errors.As(err, &appErr) || appErr.Code != apierror.CodeValidation {
		t.Fatalf("error=%v", err)
	}
	if got := appErr.Fields["preferredLanguage"]; len(got) != 1 {
		t.Fatalf("fields=%v", appErr.Fields)
	}
}
