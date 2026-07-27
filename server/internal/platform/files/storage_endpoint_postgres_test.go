package files

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/testutil"
)

func TestPostgresStorageEndpointWriteOnlySecretAndDefaultSwitch(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool := testutil.NewPool(t, ctx)
	// 默认存储切换是全局单例改写,须与并行包的同类测试互斥
	testutil.GlobalSingletonLock(t, ctx, pool)
	service := NewStorageService(pool)
	actor := &authz.Actor{UserID: uuid.New(), Username: "storage-test"}
	suffix := strings.ReplaceAll(uuid.NewString(), "-", "")[:10]
	var ids []uuid.UUID
	var previousDefaultID string
	if err := pool.QueryRow(ctx, "SELECT COALESCE((SELECT id::text FROM sys_storage WHERE is_default LIMIT 1), ' ')").Scan(&previousDefaultID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM sys_audit_log WHERE actor_id = $1", actor.UserID)
		_, _ = pool.Exec(cleanupCtx, "UPDATE sys_storage SET is_default = false WHERE id = ANY($1)", ids)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM sys_storage WHERE id = ANY($1)", ids)
		if strings.TrimSpace(previousDefaultID) != "" {
			_, _ = pool.Exec(cleanupCtx, "UPDATE sys_storage SET is_default=true WHERE id::text=$1", strings.TrimSpace(previousDefaultID))
		}
	})

	local, err := service.Create(ctx, actor, StorageCreateInput{
		Name: "l" + suffix, Label: "本地测试", Kind: "LOCAL", Root: ptr(t.TempDir()),
	})
	if err != nil {
		t.Fatal(err)
	}
	ids = append(ids, local.ID)
	secret := "sk-create"
	s3, err := service.Create(ctx, actor, StorageCreateInput{
		Name: "s" + suffix, Label: "S3 测试", Kind: "S3",
		Endpoint: ptr("http://127.0.0.1:9000"), Bucket: ptr("bucket"),
		AccessKeyID: ptr("ak"), SecretAccessKey: &secret,
	})
	if err != nil {
		t.Fatal(err)
	}
	ids = append(ids, s3.ID)
	if s3.SecretConfigured != true {
		t.Fatalf("secretConfigured = false")
	}
	if strings.Contains(toJSON(t, s3), secret) {
		t.Fatal("storage response leaked secret")
	}
	if err := service.SetDefault(ctx, actor, local.ID); err != nil {
		t.Fatal(err)
	}
	if err := service.SetDefault(ctx, actor, s3.ID); err != nil {
		t.Fatal(err)
	}
	local, err = service.Get(ctx, local.ID)
	if err != nil {
		t.Fatal(err)
	}
	s3, err = service.Get(ctx, s3.ID)
	if err != nil {
		t.Fatal(err)
	}
	if local.IsDefault || !s3.IsDefault {
		t.Fatalf("defaults: local=%v s3=%v", local.IsDefault, s3.IsDefault)
	}
	if err := service.Delete(ctx, actor, s3.ID); errorCode(err) != apierror.CodeConflict {
		t.Fatalf("default delete error = %#v", err)
	}
}
