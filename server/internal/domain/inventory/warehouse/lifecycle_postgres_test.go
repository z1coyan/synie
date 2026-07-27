package warehouse

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

func errorCode(err error) apierror.Code {
	var target *apierror.Error
	if errors.As(err, &target) {
		return target.Code
	}
	return ""
}

// 公司隔离防探测:记录存在但属于他公司时,读取/更新/删除统一表现为「不存在」。
func TestPostgresCrossCompanyIsolationReadsAsNotFound(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool := testutil.NewPool(t, ctx)

	suffix := strings.ToUpper(strings.ReplaceAll(uuid.NewString(), "-", "")[:10])
	var currencyID, companyA, companyB uuid.UUID
	if err := pool.QueryRow(ctx, `
		INSERT INTO bas_currency(name,iso_code,active) VALUES($1,$2,true) RETURNING id
	`, "仓库隔离测试币-"+suffix, "W"+suffix[:2]).Scan(&currencyID); err != nil {
		t.Fatal(err)
	}
	for code, target := range map[string]*uuid.UUID{"WA": &companyA, "WB": &companyB} {
		if err := pool.QueryRow(ctx, `
			INSERT INTO bas_company(code,name,short_name,base_currency_id)
			VALUES($1,$2,$3,$4) RETURNING id
		`, code+suffix, "仓库隔离测试公司-"+code+suffix, code+suffix, currencyID).Scan(target); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		companyIDs := []uuid.UUID{companyA, companyB}
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM sys_audit_log
			WHERE resource='inv_warehouse' AND company_id=ANY($1::uuid[])`, companyIDs)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM inv_warehouse WHERE company_id=ANY($1::uuid[])`, companyIDs)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM bas_company WHERE id=ANY($1::uuid[])`, companyIDs)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM bas_currency WHERE id=$1`, currencyID)
	})

	service := NewService(pool)
	owner := &authz.Actor{UserID: uuid.New(), Username: "warehouse-owner", CompanyIDs: []uuid.UUID{companyA}}
	outsider := &authz.Actor{UserID: uuid.New(), Username: "warehouse-outsider", CompanyIDs: []uuid.UUID{companyB}}

	item, err := service.Create(ctx, owner, CreateInput{Name: "隔离仓-" + suffix, CompanyID: companyA})
	if err != nil {
		t.Fatal(err)
	}

	if _, err := service.Get(ctx, outsider, item.ID); errorCode(err) != apierror.CodeNotFound {
		t.Fatalf("cross-company get error = %#v", err)
	}
	name := "越权改名-" + suffix
	if _, err := service.Update(ctx, outsider, item.ID, UpdateInput{Name: &name}); errorCode(err) != apierror.CodeNotFound {
		t.Fatalf("cross-company update error = %#v", err)
	}
	if err := service.Delete(ctx, outsider, item.ID); errorCode(err) != apierror.CodeNotFound {
		t.Fatalf("cross-company delete error = %#v", err)
	}

	// 越权尝试不得改动数据
	kept, err := service.Get(ctx, owner, item.ID)
	if err != nil || kept.Name != item.Name {
		t.Fatalf("warehouse after outsider attempts = %#v, %v", kept, err)
	}
}
