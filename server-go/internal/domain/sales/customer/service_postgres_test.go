package customer

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/platform/optional"
	"github.com/z1coyan/synie/server/internal/testutil"
)

func TestPostgresCustomerLifecycleAndMaterialDeleteGuard(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool := testutil.NewPool(t, ctx)

	suffix := strings.ToUpper(strings.ReplaceAll(uuid.NewString(), "-", "")[:10])
	service := NewService(pool)
	actor := &authz.Actor{UserID: uuid.New(), Username: "customer-pg-test", SuperAdmin: true}
	var customerID, categoryID, unitID, materialID uuid.UUID
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		if materialID != uuid.Nil {
			_, _ = pool.Exec(cleanupCtx, "DELETE FROM inv_material WHERE id=$1", materialID)
		}
		if customerID != uuid.Nil {
			_, _ = pool.Exec(cleanupCtx, "DELETE FROM sys_audit_log WHERE resource='sal_customer' AND record_id=$1", customerID)
			_, _ = pool.Exec(cleanupCtx, "DELETE FROM sal_customers WHERE id=$1", customerID)
		}
		if categoryID != uuid.Nil {
			_, _ = pool.Exec(cleanupCtx, "DELETE FROM inv_material_category WHERE id=$1", categoryID)
		}
		if unitID != uuid.Nil {
			_, _ = pool.Exec(cleanupCtx, "DELETE FROM bas_unit WHERE id=$1", unitID)
		}
	})

	shortName := "客户简称-" + suffix
	item, err := service.Create(ctx, actor, CreateInput{
		Code: "CUS-" + suffix, Name: "客户数据库测试-" + suffix, ShortName: &shortName,
	})
	if err != nil {
		t.Fatal(err)
	}
	customerID = item.ID
	if item.ShortName == nil || *item.ShortName != shortName {
		t.Fatalf("created = %#v", item)
	}
	if _, err := service.Create(ctx, actor, CreateInput{
		Code: item.Code, Name: "重复客户-" + suffix,
	}); customerErrorCode(err) != apierror.CodeConflict {
		t.Fatalf("duplicate error = %#v", err)
	}
	result, err := service.List(ctx, ListQuery{Search: suffix, Limit: 10})
	if err != nil || result.Count != 1 || len(result.Results) != 1 || result.Results[0].ID != item.ID {
		t.Fatalf("list = %#v, %v", result, err)
	}
	updatedName := "客户已更新-" + suffix
	updated, err := service.Update(ctx, actor, item.ID, UpdateInput{
		Name: &updatedName, ShortName: optional.Optional[string]{Set: true},
	})
	if err != nil || updated.Name != updatedName || updated.ShortName != nil {
		t.Fatalf("updated = %#v, %v", updated, err)
	}

	if err := pool.QueryRow(ctx, `
		INSERT INTO inv_material_category (code,name) VALUES ($1,$2) RETURNING id
	`, "MC-"+suffix, "客户删除守卫分类-"+suffix).Scan(&categoryID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO bas_unit (unit_type,is_base,name,symbol,ratio)
		VALUES ('quantity',false,$1,$2,1) RETURNING id
	`, "客户删除守卫单位-"+suffix, "cu-"+strings.ToLower(suffix)).Scan(&unitID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO inv_material (code,name,category_id,default_unit_id,is_customer_material,customer_id)
		VALUES ($1,$2,$3,$4,true,$5) RETURNING id
	`, "MAT-"+suffix, "客户关联物料-"+suffix, categoryID, unitID, item.ID).Scan(&materialID); err != nil {
		t.Fatal(err)
	}
	if err := service.Delete(ctx, actor, item.ID); customerErrorCode(err) != apierror.CodeConflict ||
		!strings.Contains(err.Error(), "存在关联物料") {
		t.Fatalf("referenced delete error = %#v", err)
	}
	if _, err := service.Get(ctx, item.ID); err != nil {
		t.Fatalf("customer must remain after guarded delete: %v", err)
	}
	if _, err := pool.Exec(ctx, "DELETE FROM inv_material WHERE id=$1", materialID); err != nil {
		t.Fatal(err)
	}
	materialID = uuid.Nil
	if err := service.Delete(ctx, actor, item.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Get(ctx, item.ID); customerErrorCode(err) != apierror.CodeNotFound {
		t.Fatalf("get after delete = %#v", err)
	}
	var actions []string
	rows, err := pool.Query(ctx, `
		SELECT action_type FROM sys_audit_log
		WHERE resource='sal_customer' AND record_id=$1 ORDER BY inserted_at,id
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

func customerErrorCode(err error) apierror.Code {
	var target *apierror.Error
	if errors.As(err, &target) {
		return target.Code
	}
	return ""
}
