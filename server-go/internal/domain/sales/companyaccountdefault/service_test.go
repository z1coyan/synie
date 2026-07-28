package companyaccountdefault

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

func TestCreateChecksPermissionBeforeInputOrDatabase(t *testing.T) {
	service := NewService(nil)
	_, err := service.Create(context.Background(), &authz.Actor{}, CreateInput{})
	if errorCode(err) != apierror.CodeForbidden {
		t.Fatalf("Create error = %#v, want forbidden", err)
	}
}

func TestGetChecksPermissionBeforeIdentifierOrDatabase(t *testing.T) {
	service := NewService(nil)
	_, err := service.Get(context.Background(), &authz.Actor{}, uuid.Nil)
	if errorCode(err) != apierror.CodeForbidden {
		t.Fatalf("Get error = %#v, want forbidden", err)
	}
	_, err = service.List(context.Background(), &authz.Actor{}, ListQuery{Limit: -1})
	if errorCode(err) != apierror.CodeForbidden {
		t.Fatalf("List error = %#v, want forbidden", err)
	}
	_, err = service.Update(context.Background(), &authz.Actor{}, uuid.Nil, UpdateInput{})
	if errorCode(err) != apierror.CodeForbidden {
		t.Fatalf("Update error = %#v, want forbidden", err)
	}
}

func errorCode(err error) apierror.Code {
	var target *apierror.Error
	if errors.As(err, &target) {
		return target.Code
	}
	return ""
}
