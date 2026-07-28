package files

import (
	"bytes"
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/testutil"
)

func TestPostgresConcurrentDefaultSwitchKeepsExactlyOneDefault(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool := testutil.NewPool(t, ctx)
	service := NewStorageService(pool)
	actor := &authz.Actor{UserID: uuid.New(), Username: "storage-concurrency-test"}
	suffix := strings.ReplaceAll(uuid.NewString(), "-", "")[:10]
	var previousDefaultID *uuid.UUID
	var previous uuid.UUID
	if err := pool.QueryRow(ctx, "SELECT id FROM sys_storage WHERE is_default LIMIT 1").Scan(&previous); err == nil {
		previousDefaultID = &previous
	}
	var ids []uuid.UUID
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM sys_audit_log WHERE actor_id=$1", actor.UserID)
		_, _ = pool.Exec(cleanupCtx, "UPDATE sys_storage SET is_default=false WHERE id=ANY($1)", ids)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM sys_storage WHERE id=ANY($1)", ids)
		if previousDefaultID != nil {
			_, _ = pool.Exec(cleanupCtx, "UPDATE sys_storage SET is_default=true WHERE id=$1", *previousDefaultID)
		}
	})
	create := func(name string) StorageEndpoint {
		t.Helper()
		value, createErr := service.Create(ctx, actor, StorageCreateInput{
			Name: name + suffix, Label: name, Kind: "LOCAL", Root: ptr(t.TempDir()),
		})
		if createErr != nil {
			t.Fatal(createErr)
		}
		ids = append(ids, value.ID)
		return value
	}
	first := create("ca")
	second := create("cb")

	var wait sync.WaitGroup
	errs := make(chan error, 2)
	for _, id := range []uuid.UUID{first.ID, second.ID} {
		id := id
		wait.Add(1)
		go func() {
			defer wait.Done()
			errs <- service.SetDefault(ctx, actor, id)
		}()
	}
	wait.Wait()
	close(errs)
	for switchErr := range errs {
		if switchErr != nil {
			t.Fatalf("concurrent SetDefault: %v", switchErr)
		}
	}
	var globalDefaults, fixtureDefaults int
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM sys_storage WHERE is_default").Scan(&globalDefaults); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM sys_storage WHERE is_default AND id=ANY($1)", ids).Scan(&fixtureDefaults); err != nil {
		t.Fatal(err)
	}
	if globalDefaults != 1 || fixtureDefaults != 1 {
		t.Fatalf("defaults after concurrent switches: global=%d fixture=%d", globalDefaults, fixtureDefaults)
	}
}

func TestPostgresAttachmentCompanyScopeIsFailClosed(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool := testutil.NewPool(t, ctx)
	f := createFilesFixture(t, ctx, pool)
	service := NewService(pool)

	suffix := strings.ReplaceAll(uuid.NewString(), "-", "")[:10]
	// 自带币种而非借用共享行:并行包可能选中并清理他包的临时币种,造成外键竞争。
	var currencyID uuid.UUID
	if err := pool.QueryRow(ctx, `
		INSERT INTO bas_currency (name, iso_code) VALUES ($1, $2) RETURNING id
	`, "附件测试币-"+suffix, "F"+strings.ToUpper(suffix[:6])).Scan(&currencyID); err != nil {
		t.Fatal(err)
	}
	var companyA, companyB, journalA, journalB uuid.UUID
	if err := pool.QueryRow(ctx, `
		INSERT INTO bas_company (code,name,short_name,base_currency_id)
		VALUES ($1,$2,$2,$3) RETURNING id
	`, "FA"+suffix, "附件公司甲-"+suffix, currencyID).Scan(&companyA); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO bas_company (code,name,short_name,base_currency_id)
		VALUES ($1,$2,$2,$3) RETURNING id
	`, "FB"+suffix, "附件公司乙-"+suffix, currencyID).Scan(&companyB); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO acc_gl_journal (voucher_no,date,company_id,created_by_id)
		VALUES ($1,current_date,$2,$3) RETURNING id
	`, "JA"+suffix, companyA, f.userID).Scan(&journalA); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO acc_gl_journal (voucher_no,date,company_id,created_by_id)
		VALUES ($1,current_date,$2,$3) RETURNING id
	`, "JB"+suffix, companyB, f.userID).Scan(&journalB); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM sys_attachment WHERE file_id=ANY($1)", f.fileIDs)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM sys_file WHERE id=ANY($1)", f.fileIDs)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM acc_gl_journal WHERE id=ANY($1)", []uuid.UUID{journalA, journalB})
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM bas_company WHERE id=ANY($1)", []uuid.UUID{companyA, companyB})
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM bas_currency WHERE id=$1", currencyID)
	})

	uploader := &authz.Actor{
		UserID: f.userID,
		Permissions: map[string]struct{}{
			"sys.file:create": {}, "sys.file:read": {}, "sys.file:delete": {},
			"acc.gl_journal:read": {},
		},
		CompanyIDs: []uuid.UUID{companyA, companyB},
	}
	upload := func(ownerID uuid.UUID, filename string) UploadResult {
		t.Helper()
		result, uploadErr := service.Upload(ctx, uploader, UploadInput{
			Reader: bytes.NewReader([]byte(filename)), Filename: filename,
			OwnerType: "acc_gl_journal", OwnerID: &ownerID,
		})
		if uploadErr != nil {
			t.Fatal(uploadErr)
		}
		if result.Attachment == nil {
			t.Fatal("upload did not create attachment")
		}
		f.fileIDs = append(f.fileIDs, result.File.ID)
		f.attachmentIDs = append(f.attachmentIDs, result.Attachment.ID)
		return result
	}
	fileA := upload(journalA, "甲.txt")
	fileB := upload(journalB, "乙.txt")

	companyAActor := &authz.Actor{
		UserID: f.userID,
		Permissions: map[string]struct{}{
			"sys.file:read": {}, "acc.gl_journal:read": {},
		},
		CompanyIDs: []uuid.UUID{companyA},
	}
	list, err := service.ListAttachments(ctx, companyAActor, AttachmentQuery{})
	if err != nil {
		t.Fatal(err)
	}
	// 不断言精确条数:并行包可能插入全局可见(company NULL)的附件(如打印模板)。
	// fail-closed 的本质是:自己的附件可见,他公司(companyB)的附件绝不出现。
	var sawA bool
	for _, item := range list.Results {
		if item.FileID == fileA.File.ID {
			sawA = true
		}
		if item.FileID == fileB.File.ID || (item.CompanyID != nil && *item.CompanyID == companyB) {
			t.Fatalf("company B attachment leaked into company A list: %#v", list)
		}
	}
	if !sawA {
		t.Fatalf("company A attachment missing from list: %#v", list)
	}
	if _, err := service.Download(ctx, companyAActor, fileA.File.ID); err != nil {
		t.Fatalf("company A download: %v", err)
	}
	if _, err := service.Download(ctx, companyAActor, fileB.File.ID); errorCode(err) != apierror.CodeForbidden {
		t.Fatalf("cross-company download error = %#v", err)
	}
}
