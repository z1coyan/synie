package unit

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/testutil"
)

func TestPostgresUnitLifecycle(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool := testutil.NewPool(t, ctx)

	service := NewService(pool)
	suffix := strings.ToLower(strings.ReplaceAll(uuid.NewString(), "-", "")[:10])
	actor := &authz.Actor{UserID: uuid.New(), Username: "unit-postgres-test", SuperAdmin: true}
	baseSymbol := "b" + suffix
	childSymbol := "u" + suffix
	var ids []uuid.UUID
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		for _, id := range ids {
			_, _ = pool.Exec(cleanupCtx, "DELETE FROM sys_audit_log WHERE resource = 'bas_unit' AND record_id = $1", id)
			_, _ = pool.Exec(cleanupCtx, "DELETE FROM bas_unit WHERE id = $1", id)
		}
	})

	isBase := true
	base, err := service.Create(ctx, actor, CreateInput{
		UnitType: "AREA", IsBase: &isBase, Name: "数据库冒烟基准-" + suffix,
		Symbol: baseSymbol, Ratio: "1",
	})
	if err != nil {
		t.Fatal(err)
	}
	ids = append(ids, base.ID)

	if _, err = service.Create(ctx, actor, CreateInput{
		UnitType: "AREA", IsBase: &isBase, Name: "数据库冒烟重复基准-" + suffix,
		Symbol: "d" + suffix, Ratio: "1",
	}); errorCode(err) != apierror.CodeConflict {
		t.Fatalf("duplicate base error = %#v", err)
	}

	child, err := service.Create(ctx, actor, CreateInput{
		UnitType: "AREA", Name: "数据库冒烟单位-" + suffix, Symbol: childSymbol, Ratio: "0.000001",
	})
	if err != nil {
		t.Fatal(err)
	}
	ids = append(ids, child.ID)
	if child.UnitType != "AREA" || child.Ratio.String() != "0.000001" {
		t.Fatalf("created unit = %#v", child)
	}

	result, err := service.List(ctx, ListQuery{Limit: 10, Search: childSymbol})
	if err != nil {
		t.Fatal(err)
	}
	if result.Count != 1 || len(result.Results) != 1 || result.Results[0].ID != child.ID {
		t.Fatalf("list = %#v", result)
	}

	newName := "数据库冒烟单位已更新-" + suffix
	newRatio := "0.000002"
	updated, err := service.Update(ctx, actor, child.ID, UpdateInput{Name: &newName, Ratio: &newRatio})
	if err != nil {
		t.Fatal(err)
	}
	if updated.Name != newName || updated.Ratio.String() != newRatio {
		t.Fatalf("updated unit = %#v", updated)
	}

	var auditActions []string
	rows, err := pool.Query(ctx, `
		SELECT action_type
		FROM sys_audit_log
		WHERE resource = 'bas_unit' AND record_id = $1
		ORDER BY inserted_at, id
	`, child.ID)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var action string
		if err := rows.Scan(&action); err != nil {
			rows.Close()
			t.Fatal(err)
		}
		auditActions = append(auditActions, action)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(auditActions) != "[create update]" {
		t.Fatalf("audit actions = %#v", auditActions)
	}

	if err := service.Delete(ctx, actor, child.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Get(ctx, child.ID); errorCode(err) != apierror.CodeNotFound {
		t.Fatalf("get after delete = %#v", err)
	}
	var destroyCount int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM sys_audit_log
		WHERE resource = 'bas_unit' AND record_id = $1 AND action_type = 'destroy'
	`, child.ID).Scan(&destroyCount); err != nil {
		t.Fatal(err)
	}
	if destroyCount != 1 {
		t.Fatalf("destroy audit count = %d", destroyCount)
	}

	if err := service.Delete(ctx, actor, base.ID); err != nil && !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
}

func errorCode(err error) apierror.Code {
	var appErr *apierror.Error
	if errors.As(err, &appErr) {
		return appErr.Code
	}
	return ""
}
