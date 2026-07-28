package account

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/platform/optional"
	"github.com/z1coyan/synie/server/internal/testutil"
)

func TestPostgresAccountLifecycleScopeAndCycle(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool := testutil.NewPool(t, ctx)

	suffix := strings.ToLower(strings.ReplaceAll(uuid.NewString(), "-", "")[:10])
	fixture := createAccountFixture(t, ctx, pool, suffix)
	service := NewService(pool)
	actor := &authz.Actor{UserID: uuid.New(), Username: "account-lifecycle-test", CompanyIDs: []uuid.UUID{fixture.companyID}}
	outsider := &authz.Actor{UserID: uuid.New(), Username: "account-outsider", CompanyIDs: []uuid.UUID{fixture.otherCompanyID}}

	root, err := service.Create(ctx, actor, CreateInput{
		Code: "R" + suffix, Name: "根科目-" + suffix, Direction: "DEBIT",
		IsGroup: true, CompanyID: fixture.companyID,
	})
	if err != nil {
		t.Fatal(err)
	}
	fixture.accountIDs = append(fixture.accountIDs, root.ID)
	child, err := service.Create(ctx, actor, CreateInput{
		Code: "C" + suffix, Name: "子科目-" + suffix, Direction: "DEBIT",
		IsGroup: true, ParentID: &root.ID, CompanyID: fixture.companyID,
	})
	if err != nil {
		t.Fatal(err)
	}
	fixture.accountIDs = append(fixture.accountIDs, child.ID)
	leaf, err := service.Create(ctx, actor, CreateInput{
		Code: "D" + suffix, Name: "末级科目-" + suffix, Direction: "DEBIT",
		ParentID: &child.ID, CompanyID: fixture.companyID,
	})
	if err != nil {
		t.Fatal(err)
	}
	fixture.accountIDs = append(fixture.accountIDs, leaf.ID)

	result, err := service.List(ctx, actor, ListQuery{Limit: 20, Search: suffix})
	if err != nil {
		t.Fatal(err)
	}
	if result.Count != 3 {
		t.Fatalf("scoped list count = %d, want 3", result.Count)
	}
	for _, item := range result.Results {
		if item.CompanyID != fixture.companyID {
			t.Fatalf("scoped list leaked company %s", item.CompanyID)
		}
	}
	if _, err := service.Get(ctx, outsider, root.ID); errorCode(err) != apierror.CodeNotFound {
		t.Fatalf("outside-company get error = %#v", err)
	}

	parent := &leaf.ID
	if _, err := service.Update(ctx, actor, root.ID, UpdateInput{ParentID: optional.Of(*parent)}); errorCode(err) != apierror.CodeValidation {
		t.Fatalf("deep cycle update error = %#v", err)
	}
	if err := service.Delete(ctx, actor, root.ID); errorCode(err) != apierror.CodeConflict {
		t.Fatalf("delete parent error = %#v", err)
	}

	updatedName := "末级科目已更新-" + suffix
	active := false
	updated, err := service.Update(ctx, actor, leaf.ID, UpdateInput{Name: &updatedName, Active: &active})
	if err != nil {
		t.Fatal(err)
	}
	if updated.Name != updatedName || updated.Active {
		t.Fatalf("updated leaf = %#v", updated)
	}
	if err := service.Delete(ctx, actor, leaf.ID); err != nil {
		t.Fatal(err)
	}
	if err := service.Delete(ctx, actor, child.ID); err != nil {
		t.Fatal(err)
	}
	if err := service.Delete(ctx, actor, root.ID); err != nil {
		t.Fatal(err)
	}

	var createCount, updateCount, destroyCount int
	if err := pool.QueryRow(ctx, `
		SELECT
			count(*) FILTER (WHERE action_type = 'create'),
			count(*) FILTER (WHERE action_type = 'update'),
			count(*) FILTER (WHERE action_type = 'destroy')
		FROM sys_audit_log
		WHERE resource = 'bas_account' AND record_id = $1
	`, leaf.ID).Scan(&createCount, &updateCount, &destroyCount); err != nil {
		t.Fatal(err)
	}
	if createCount != 1 || updateCount != 1 || destroyCount != 1 {
		t.Fatalf("leaf audit counts = create:%d update:%d destroy:%d", createCount, updateCount, destroyCount)
	}
}
