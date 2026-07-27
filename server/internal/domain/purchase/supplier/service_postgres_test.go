package supplier

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/testutil"
)

func TestPostgresSupplierLifecycle(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool := testutil.NewPool(t, ctx)

	suffix := strings.ToUpper(strings.ReplaceAll(uuid.NewString(), "-", "")[:10])
	service := NewService(pool)
	actor := &authz.Actor{UserID: uuid.New(), Username: "supplier-pg-test", SuperAdmin: true}
	var supplierID uuid.UUID
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		if supplierID != uuid.Nil {
			_, _ = pool.Exec(cleanupCtx, "DELETE FROM sys_audit_log WHERE resource='pur_supplier' AND record_id=$1", supplierID)
			_, _ = pool.Exec(cleanupCtx, "DELETE FROM pur_supplier WHERE id=$1", supplierID)
		}
	})

	shortName := "供应商简称-" + suffix
	item, err := service.Create(ctx, actor, CreateInput{
		Code: "SUP-" + suffix, Name: "供应商数据库测试-" + suffix, ShortName: &shortName,
	})
	if err != nil {
		t.Fatal(err)
	}
	supplierID = item.ID
	if _, err := service.Create(ctx, actor, CreateInput{
		Code: item.Code, Name: "重复供应商-" + suffix,
	}); supplierErrorCode(err) != apierror.CodeConflict {
		t.Fatalf("duplicate error = %#v", err)
	}
	result, err := service.List(ctx, ListQuery{Search: suffix, Limit: 10})
	if err != nil || result.Count != 1 || len(result.Results) != 1 || result.Results[0].ID != item.ID {
		t.Fatalf("list = %#v, %v", result, err)
	}
	updatedCode := "SUP2-" + suffix
	updated, err := service.Update(ctx, actor, item.ID, UpdateInput{Code: &updatedCode})
	if err != nil || updated.Code != updatedCode {
		t.Fatalf("updated = %#v, %v", updated, err)
	}
	if err := service.Delete(ctx, actor, item.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Get(ctx, item.ID); supplierErrorCode(err) != apierror.CodeNotFound {
		t.Fatalf("get after delete = %#v", err)
	}
	var actions []string
	rows, err := pool.Query(ctx, `
		SELECT action_type FROM sys_audit_log
		WHERE resource='pur_supplier' AND record_id=$1 ORDER BY inserted_at,id
	`, item.ID)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var action string
		if err := rows.Scan(&action); err != nil {
			rows.Close()
			t.Fatal(err)
		}
		actions = append(actions, action)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if strings.Join(actions, ",") != "create,update,destroy" {
		t.Fatalf("audit actions = %#v", actions)
	}
}

func supplierErrorCode(err error) apierror.Code {
	var target *apierror.Error
	if errors.As(err, &target) {
		return target.Code
	}
	return ""
}
