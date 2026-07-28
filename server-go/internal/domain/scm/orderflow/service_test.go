package orderflow

import (
	"context"
	"errors"
	"testing"

	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

func TestReadChecksAnySourcePermissionBeforeInputOrDatabase(t *testing.T) {
	service := NewService(nil)
	_, err := service.Get(context.Background(), &authz.Actor{}, "")
	if errorCode(err) != apierror.CodeForbidden {
		t.Fatalf("Get error = %#v, want forbidden", err)
	}
	_, err = service.List(context.Background(), &authz.Actor{}, ListQuery{Limit: -1})
	if errorCode(err) != apierror.CodeForbidden {
		t.Fatalf("List error = %#v, want forbidden", err)
	}
}

func errorCode(err error) apierror.Code {
	var target *apierror.Error
	if errors.As(err, &target) {
		return target.Code
	}
	return ""
}
