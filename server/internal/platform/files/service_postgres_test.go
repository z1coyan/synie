package files

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/testutil"
)

func TestPostgresUploadAttachDownloadAndDeleteGuards(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool := testutil.NewPool(t, ctx)

	f := createFilesFixture(t, ctx, pool)
	service := NewService(pool)
	actor := &authz.Actor{
		UserID: f.userID, Username: "files-test", SuperAdmin: false,
		Permissions: map[string]struct{}{
			"sys.file:create":     {},
			"sys.file:read":       {},
			"sys.file:delete":     {},
			"sales.customer:read": {},
		},
	}

	result, err := service.Upload(ctx, actor, UploadInput{
		Reader: bytes.NewReader([]byte("PDF 内容")), Filename: "合同.PDF",
		ContentType: "application/pdf",
	})
	if err != nil {
		t.Fatal(err)
	}
	f.fileIDs = append(f.fileIDs, result.File.ID)
	if result.Attachment != nil || result.File.Storage != f.storageName ||
		result.File.Size != int64(len("PDF 内容")) ||
		!strings.HasSuffix(result.File.Key, ".pdf") {
		t.Fatalf("upload = %#v", result)
	}
	if _, err := os.Stat(filepath.Join(f.root, filepath.FromSlash(result.File.Key))); err != nil {
		t.Fatalf("stored object missing: %v", err)
	}

	if _, err := service.Download(ctx, &authz.Actor{
		UserID: uuid.New(), Permissions: map[string]struct{}{"sys.file:read": {}},
	}, result.File.ID); errorCode(err) != apierror.CodeForbidden {
		t.Fatalf("other user bare-file download error = %#v", err)
	}
	download, err := service.Download(ctx, actor, result.File.ID)
	if err != nil || string(download.Content) != "PDF 内容" {
		t.Fatalf("download = %#v, %v", download, err)
	}

	attachment, err := service.Attach(ctx, actor, result.File.ID, AttachInput{
		OwnerType: "sal_customer", OwnerID: f.customerID, Category: "contract",
	})
	if err != nil {
		t.Fatal(err)
	}
	f.attachmentIDs = append(f.attachmentIDs, attachment.ID)
	if attachment.Category != "contract" || attachment.CompanyID != nil {
		t.Fatalf("attachment = %#v", attachment)
	}

	if err := service.DeleteFile(ctx, actor, result.File.ID); errorCode(err) != apierror.CodeConflict {
		t.Fatalf("attached delete error = %#v", err)
	}
	if err := service.DeleteAttachment(ctx, actor, attachment.ID); err != nil {
		t.Fatal(err)
	}
	f.attachmentIDs = nil
	if err := service.DeleteFile(ctx, actor, result.File.ID); err != nil {
		t.Fatal(err)
	}
	f.fileIDs = nil
	if _, err := os.Stat(filepath.Join(f.root, filepath.FromSlash(result.File.Key))); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("object still exists: %v", err)
	}
}

func TestPostgresUploadUnknownOwnerRollsBackRowAndObject(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool := testutil.NewPool(t, ctx)
	f := createFilesFixture(t, ctx, pool)
	service := NewService(pool)
	actor := &authz.Actor{UserID: f.userID, Permissions: map[string]struct{}{"sys.file:create": {}}}

	_, err := service.Upload(ctx, actor, UploadInput{
		Reader: bytes.NewReader([]byte("x")), Filename: "x.txt",
		OwnerType: "not_a_resource", OwnerID: &f.customerID,
	})
	if errorCode(err) != apierror.CodeValidation {
		t.Fatalf("unknown owner error = %#v", err)
	}
	var rows int
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM sys_file WHERE uploaded_by_id = $1", f.userID).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 0 {
		t.Fatalf("file rows after rollback = %d", rows)
	}
	entries, err := os.ReadDir(f.root)
	if err != nil {
		t.Fatal(err)
	}
	if objectCount(f.root, entries) != 0 {
		t.Fatal("physical object remained after rollback")
	}
}

type filesFixture struct {
	pool              *pgxpool.Pool
	userID            uuid.UUID
	customerID        uuid.UUID
	storageID         uuid.UUID
	previousDefaultID *uuid.UUID
	storageName       string
	root              string
	fileIDs           []uuid.UUID
	attachmentIDs     []uuid.UUID
}

func createFilesFixture(t *testing.T, ctx context.Context, pool *pgxpool.Pool) *filesFixture {
	t.Helper()
	// 交换默认存储是全局单例改写,须与并行包的同类测试互斥
	testutil.GlobalSingletonLock(t, ctx, pool)
	suffix := strings.ReplaceAll(uuid.NewString(), "-", "")[:10]
	f := &filesFixture{pool: pool, storageName: "t" + suffix, root: t.TempDir()}
	if err := pool.QueryRow(ctx, `
		INSERT INTO sys_user (username, name, hashed_password)
		VALUES ($1, $2, 'test-only') RETURNING id
	`, "files_"+suffix, "文件测试用户").Scan(&f.userID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO sal_customers (code, name)
		VALUES ($1, $2) RETURNING id
	`, "F"+suffix, "文件测试客户-"+suffix).Scan(&f.customerID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO sys_storage (name, label, kind, root, is_default)
		VALUES ($1, $2, 'local', $3, false) RETURNING id
	`, f.storageName, "文件测试存储", f.root).Scan(&f.storageID); err != nil {
		t.Fatal(err)
	}
	var previousDefault uuid.UUID
	if err := pool.QueryRow(ctx, "SELECT id FROM sys_storage WHERE is_default=true").Scan(&previousDefault); err == nil {
		f.previousDefaultID = &previousDefault
	} else if !errors.Is(err, pgx.ErrNoRows) {
		t.Fatal(err)
	}
	// 避免依赖开发库当前默认行；测试结束恢复原默认。
	if _, err := pool.Exec(ctx, "UPDATE sys_storage SET is_default = false WHERE is_default"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, "UPDATE sys_storage SET is_default = true WHERE id = $1", f.storageID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM sys_audit_log WHERE actor_id = $1", f.userID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM sys_attachment WHERE file_id = ANY($1)", f.fileIDs)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM sys_file WHERE id = ANY($1)", f.fileIDs)
		_, _ = pool.Exec(cleanupCtx, "UPDATE sys_storage SET is_default = false WHERE id = $1", f.storageID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM sys_storage WHERE id = $1", f.storageID)
		if f.previousDefaultID != nil {
			_, _ = pool.Exec(cleanupCtx, "UPDATE sys_storage SET is_default=true WHERE id=$1", *f.previousDefaultID)
		}
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM sal_customers WHERE id = $1", f.customerID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM sys_user WHERE id = $1", f.userID)
	})
	return f
}

func objectCount(root string, entries []os.DirEntry) int {
	total := 0
	for _, entry := range entries {
		if entry.IsDir() {
			children, _ := os.ReadDir(filepath.Join(root, entry.Name()))
			total += objectCount(filepath.Join(root, entry.Name()), children)
		} else {
			total++
		}
	}
	return total
}

func errorCode(err error) apierror.Code {
	var appErr *apierror.Error
	if errors.As(err, &appErr) {
		return appErr.Code
	}
	return ""
}
