package printing

import (
	"bytes"
	"context"
	"errors"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/platform/files"
)

func TestPostgresTemplateCRUDDefaultAttachmentAuditAndPermissions(t *testing.T) {
	databaseURL := os.Getenv("SYNIE_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("set SYNIE_TEST_DATABASE_URL to run the real PostgreSQL test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	fixture := createPrintingFixture(t, ctx, pool)
	fileService := files.NewService(pool)
	service := NewService(pool, fileService, NewFieldCatalog())
	actor := &authz.Actor{
		UserID: fixture.userID, Username: "printing-test",
		Permissions: map[string]struct{}{
			"sys.file:create":           {},
			"sys.file:read":             {},
			"sys.file:delete":           {},
			"sys.print_template:create": {},
			"sys.print_template:read":   {},
			"sys.print_template:update": {},
			"sys.print_template:delete": {},
		},
	}
	validWorkbook := workbookFixture(t, map[string]string{
		"xl/workbook.xml":            `<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="A" r:id="rId1"/></sheets></workbook>`,
		"xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
		"xl/worksheets/sheet1.xml":   `<worksheet><sheetData><row><c t="inlineStr"><is><t>${order_no} ${items.qty}</t></is></c></row></sheetData></worksheet>`,
	})
	invalidWorkbook := workbookFixture(t, map[string]string{
		"xl/workbook.xml":            `<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="A" r:id="rId1"/></sheets></workbook>`,
		"xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
		"xl/worksheets/sheet1.xml":   `<worksheet><sheetData><row><c t="inlineStr"><is><t>${not_a_field}</t></is></c></row></sheetData></worksheet>`,
	})
	upload := func(name string, value []byte) files.File {
		t.Helper()
		result, uploadErr := fileService.Upload(ctx, actor, files.UploadInput{
			Reader: bytes.NewReader(value), Filename: name,
			ContentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		})
		if uploadErr != nil {
			t.Fatal(uploadErr)
		}
		fixture.fileIDs = append(fixture.fileIDs, result.File.ID)
		return result.File
	}
	firstFile := upload("订单模板.XLSX", validWorkbook)
	secondFile := upload("订单模板-二.xlsx", validWorkbook)
	invalidFile := upload("非法字段.xlsx", invalidWorkbook)
	textFile := upload("伪装.txt", validWorkbook)

	if _, err := service.Create(ctx, actor, CreateInput{
		Name: "非法扩展名", Resource: "sales.order", FileID: textFile.ID,
	}); codeOf(err) != apierror.CodeValidation || err.Error() != "只接受 .xlsx 模板文件" {
		t.Fatalf("extension error = %#v", err)
	}
	if _, err := service.Create(ctx, actor, CreateInput{
		Name: "非法字段", Resource: "sales.order", FileID: invalidFile.ID,
	}); codeOf(err) != apierror.CodeValidation || !strings.Contains(err.Error(), "未知头字段: not_a_field") {
		t.Fatalf("placeholder error = %#v", err)
	}

	remarks := "第一版"
	first, err := service.Create(ctx, actor, CreateInput{
		Name: "销售订单", Resource: "sales.order", FileID: firstFile.ID, Remarks: &remarks,
	})
	if err != nil {
		t.Fatal(err)
	}
	fixture.templateIDs = append(fixture.templateIDs, first.ID)
	second, err := service.Create(ctx, actor, CreateInput{
		Name: "销售订单备用", Resource: "sales.order", FileID: secondFile.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	fixture.templateIDs = append(fixture.templateIDs, second.ID)

	filtered, err := service.List(ctx, ListQuery{Limit: 20, Search: "备用"})
	if err != nil || filtered.Count != 1 || filtered.Results[0].ID != second.ID {
		t.Fatalf("filtered list = %#v, %v", filtered, err)
	}
	printActor := &authz.Actor{
		UserID:      fixture.userID,
		Permissions: map[string]struct{}{"sales.order:print": {}},
	}
	usable, err := service.ListUsable(ctx, printActor, "sales.order")
	if err != nil || len(usable) != 2 {
		t.Fatalf("print-authorized templates = %#v, %v", usable, err)
	}
	if _, err := service.ListUsable(ctx, &authz.Actor{UserID: fixture.userID}, "sales.order"); codeOf(err) != apierror.CodeForbidden {
		t.Fatalf("unauthorized usable-list error = %#v", err)
	}

	var wait sync.WaitGroup
	errs := make(chan error, 2)
	for _, id := range []uuid.UUID{first.ID, second.ID} {
		id := id
		wait.Add(1)
		go func() {
			defer wait.Done()
			_, setErr := service.SetDefault(ctx, actor, id)
			errs <- setErr
		}()
	}
	wait.Wait()
	close(errs)
	for setErr := range errs {
		if setErr != nil {
			t.Fatalf("concurrent SetDefault: %v", setErr)
		}
	}
	var defaults int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM sys_print_template
		WHERE resource='sales.order' AND is_default AND id=ANY($1)
	`, fixture.templateIDs).Scan(&defaults); err != nil {
		t.Fatal(err)
	}
	if defaults != 1 {
		t.Fatalf("defaults = %d, want 1", defaults)
	}

	updatedName := "销售订单新版"
	noRemarks := (*string)(nil)
	updated, err := service.Update(ctx, actor, first.ID, UpdateInput{
		Name: &updatedName, FileID: &secondFile.ID, Remarks: &noRemarks,
	})
	if err != nil {
		t.Fatal(err)
	}
	if updated.Name != updatedName || updated.Remarks != nil || updated.Resource != "sales.order" {
		t.Fatalf("updated = %#v", updated)
	}
	var oldAttachments, newAttachments int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FILTER (WHERE file_id=$2),
		       count(*) FILTER (WHERE file_id=$3)
		FROM sys_attachment
		WHERE owner_type='sys_print_template' AND owner_id=$1
	`, first.ID, firstFile.ID, secondFile.ID).Scan(&oldAttachments, &newAttachments); err != nil {
		t.Fatal(err)
	}
	if oldAttachments != 0 || newAttachments != 1 {
		t.Fatalf("attachments old=%d new=%d", oldAttachments, newAttachments)
	}

	if err := service.Delete(ctx, actor, first.ID); err != nil {
		t.Fatal(err)
	}
	fixture.templateIDs = fixture.templateIDs[1:]
	var attachmentRows, fileRows, auditRows int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM sys_attachment
		WHERE owner_type='sys_print_template' AND owner_id=$1
	`, first.ID).Scan(&attachmentRows); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM sys_file WHERE id=$1", secondFile.ID).Scan(&fileRows); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM sys_audit_log
		WHERE resource='sys_print_template' AND record_id=$1 AND actor_id=$2
	`, first.ID, actor.UserID).Scan(&auditRows); err != nil {
		t.Fatal(err)
	}
	if attachmentRows != 0 || fileRows != 1 || auditRows < 3 {
		t.Fatalf("post-delete attachment=%d file=%d audit=%d", attachmentRows, fileRows, auditRows)
	}
}

type printingFixture struct {
	userID            uuid.UUID
	storageID         uuid.UUID
	previousDefaultID *uuid.UUID
	fileIDs           []uuid.UUID
	templateIDs       []uuid.UUID
}

func createPrintingFixture(t *testing.T, ctx context.Context, pool *pgxpool.Pool) *printingFixture {
	t.Helper()
	suffix := strings.ReplaceAll(uuid.NewString(), "-", "")[:10]
	fixture := &printingFixture{}
	if err := pool.QueryRow(ctx, `
		INSERT INTO sys_user (username,name,hashed_password)
		VALUES ($1,'打印测试用户','test-only') RETURNING id
	`, "printing_"+suffix).Scan(&fixture.userID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO sys_storage (name,label,kind,root,is_default)
		VALUES ($1,'打印测试存储','local',$2,false) RETURNING id
	`, "pt"+suffix, t.TempDir()).Scan(&fixture.storageID); err != nil {
		t.Fatal(err)
	}
	var previous uuid.UUID
	if err := pool.QueryRow(ctx, "SELECT id FROM sys_storage WHERE is_default").Scan(&previous); err == nil {
		fixture.previousDefaultID = &previous
	} else if !errors.Is(err, pgx.ErrNoRows) {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, "UPDATE sys_storage SET is_default=false WHERE is_default"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, "UPDATE sys_storage SET is_default=true WHERE id=$1", fixture.storageID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM sys_audit_log WHERE actor_id=$1", fixture.userID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM sys_attachment WHERE owner_type='sys_print_template' AND owner_id=ANY($1)", fixture.templateIDs)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM sys_print_template WHERE id=ANY($1)", fixture.templateIDs)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM sys_attachment WHERE file_id=ANY($1)", fixture.fileIDs)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM sys_file WHERE id=ANY($1)", fixture.fileIDs)
		_, _ = pool.Exec(cleanupCtx, "UPDATE sys_storage SET is_default=false WHERE id=$1", fixture.storageID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM sys_storage WHERE id=$1", fixture.storageID)
		if fixture.previousDefaultID != nil {
			_, _ = pool.Exec(cleanupCtx, "UPDATE sys_storage SET is_default=true WHERE id=$1", *fixture.previousDefaultID)
		}
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM sys_user WHERE id=$1", fixture.userID)
	})
	return fixture
}
