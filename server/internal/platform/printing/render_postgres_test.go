package printing

import (
	"bytes"
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/platform/files"
)

type stubPDFConverter struct {
	lastInput []byte
	output    []byte
	err       error
}

func (c *stubPDFConverter) ConvertXlsxToPDF(_ context.Context, xlsx []byte) ([]byte, error) {
	c.lastInput = xlsx
	return c.output, c.err
}

type salesOrderRenderFixture struct {
	companyID  uuid.UUID
	currencyID uuid.UUID
	customerID uuid.UUID
	unitID     uuid.UUID
	categoryID uuid.UUID
	materialID uuid.UUID
	orderIDs   []uuid.UUID
	suffix     string
}

// 真实 PG 端到端：造销售订单 → 上传模板 → 渲染导出/打印。
func TestPostgresSalesOrderRender(t *testing.T) {
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

	printingFx := createPrintingFixture(t, ctx, pool)
	fx := seedSalesOrderRenderFixture(t, ctx, pool)

	fileService := files.NewService(pool)
	service := NewService(pool, fileService, newTestCatalog())
	actor := &authz.Actor{
		UserID: printingFx.userID, Username: "printing-render-test",
		Permissions: map[string]struct{}{
			"sys.file:create":           {},
			"sys.print_template:create": {},
			"sales.order:print":         {},
			"sales.order:export":        {},
			"sales.order:batch_print":   {},
		},
		CompanyIDs: []uuid.UUID{fx.companyID},
	}

	templateWorkbook := workbookFixture(t, map[string]string{
		"xl/workbook.xml":            renderTestWorkbook,
		"xl/_rels/workbook.xml.rels": renderTestRels,
		"[Content_Types].xml":        renderTestContentTypes,
		"xl/worksheets/sheet1.xml": `<worksheet><sheetData>` +
			`<row r="1"><c r="A1" t="inlineStr"><is><t>订单 ${order_no}</t></is></c>` +
			`<c r="B1" t="inlineStr"><is><t>${company.name}</t></is></c>` +
			`<c r="C1" t="inlineStr"><is><t>${party.name}</t></is></c>` +
			`<c r="D1" t="inlineStr"><is><t>${status}</t></is></c>` +
			`<c r="E1" t="inlineStr"><is><t>${gross_total}</t></is></c></row>` +
			`<row r="2"><c r="A2" t="inlineStr"><is><t>${items._seq}</t></is></c>` +
			`<c r="B2" t="inlineStr"><is><t>${items.material_name}</t></is></c>` +
			`<c r="C2" t="inlineStr"><is><t>${items.qty}</t></is></c>` +
			`<c r="D2" t="inlineStr"><is><t>${items.unit_name}</t></is></c>` +
			`<c r="E2" t="inlineStr"><is><t>${items.amount}</t></is></c></row>` +
			`</sheetData></worksheet>`,
	})
	uploaded, err := fileService.Upload(ctx, actor, files.UploadInput{
		Reader: bytes.NewReader(templateWorkbook), Filename: "渲染验收模板.xlsx",
		ContentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	})
	if err != nil {
		t.Fatal(err)
	}
	printingFx.fileIDs = append(printingFx.fileIDs, uploaded.File.ID)
	template, err := service.Create(ctx, actor, CreateInput{
		Name: "渲染验收", Resource: "sales.order", FileID: uploaded.File.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	printingFx.templateIDs = append(printingFx.templateIDs, template.ID)

	// 导出：单条 → 单 sheet，关键单元格断言
	exported, err := service.Render(ctx, actor, RenderInput{
		Resource: "sales.order", Mode: RenderModeExport,
		TemplateID: template.ID, IDs: []uuid.UUID{fx.orderIDs[0]},
	})
	if err != nil {
		t.Fatal(err)
	}
	if exported.ContentType != xlsxContentType {
		t.Fatalf("content type = %q", exported.ContentType)
	}
	if !strings.HasPrefix(exported.Filename, "PRT"+fx.suffix) || !strings.HasSuffix(exported.Filename, ".xlsx") {
		t.Fatalf("filename = %q", exported.Filename)
	}
	sheet := readPart(t, exported.Binary, "xl/worksheets/sheet_synie_1.xml")
	texts := strings.Join(sheetCellTexts(sheet), "|")
	for _, want := range []string{
		"订单 PRT" + fx.suffix, "打印公司-" + fx.suffix, "打印客户-" + fx.suffix, "草稿",
		"1", "打印物料-" + fx.suffix, "2", "打印个-" + fx.suffix, "20",
		"打印物料二-" + fx.suffix, "30",
	} {
		if !strings.Contains(texts, want) {
			t.Fatalf("导出内容缺少 %q: %s", want, texts)
		}
	}
	// 2 条目展开 + 无占位符残留
	if got := strings.Join(rowNumbers(sheet), ","); got != "1,2,3" {
		t.Fatalf("行号 = %s, want 1,2,3", got)
	}
	if strings.Contains(sheet, "${") {
		t.Fatalf("残留占位符: %s", sheet)
	}

	// 批量导出：两单两 sheet，sheet 名为单号
	batch, err := service.Render(ctx, actor, RenderInput{
		Resource: "sales.order", Mode: RenderModeExport,
		TemplateID: template.ID, IDs: fx.orderIDs,
	})
	if err != nil {
		t.Fatal(err)
	}
	wb := readPart(t, batch.Binary, "xl/workbook.xml")
	if !strings.Contains(wb, `name="PRT`+fx.suffix+`"`) || !strings.Contains(wb, `name="PRB`+fx.suffix+`"`) {
		t.Fatalf("批量 sheet 名不正确: %s", wb)
	}

	// 打印：注入 stub 转换器，断言渲染 xlsx 内容且输出 PDF
	stub := &stubPDFConverter{output: []byte("%PDF-1.4 stub")}
	service.SetPDFConverter(stub)
	printed, err := service.Render(ctx, actor, RenderInput{
		Resource: "sales.order", Mode: RenderModePrint,
		TemplateID: template.ID, IDs: []uuid.UUID{fx.orderIDs[0]},
	})
	if err != nil {
		t.Fatal(err)
	}
	if printed.ContentType != pdfContentType || string(printed.Binary) != "%PDF-1.4 stub" {
		t.Fatalf("打印产物 = %q %q", printed.ContentType, printed.Binary)
	}
	printSheet := readPart(t, stub.lastInput, "xl/worksheets/sheet1.xml")
	if !strings.Contains(strings.Join(sheetCellTexts(printSheet), "|"), "订单 PRT"+fx.suffix) {
		t.Fatalf("打印渲染产物不正确: %s", printSheet)
	}
	if !strings.HasSuffix(printed.Filename, ".pdf") {
		t.Fatalf("打印文件名 = %q", printed.Filename)
	}

	// 降级：soffice 不存在 → 明确中文错误而非崩溃
	service.SetPDFConverter(NewSofficeConverter("/nonexistent/soffice", time.Second, 1))
	_, err = service.Render(ctx, actor, RenderInput{
		Resource: "sales.order", Mode: RenderModePrint,
		TemplateID: template.ID, IDs: []uuid.UUID{fx.orderIDs[0]},
	})
	if err == nil || !strings.Contains(err.Error(), "未找到 LibreOffice") {
		t.Fatalf("降级错误 = %v", err)
	}

	// 权限否定：无 export 权限
	_, err = service.Render(ctx, &authz.Actor{
		UserID: printingFx.userID, Permissions: map[string]struct{}{},
		CompanyIDs: []uuid.UUID{fx.companyID},
	}, RenderInput{
		Resource: "sales.order", Mode: RenderModeExport,
		TemplateID: template.ID, IDs: []uuid.UUID{fx.orderIDs[0]},
	})
	if codeOf(err) != apierror.CodeForbidden {
		t.Fatalf("无权限错误 = %#v", err)
	}

	// 公司数据权限：其他公司 actor 读不到单据
	_, err = service.Render(ctx, &authz.Actor{
		UserID:      printingFx.userID,
		Permissions: map[string]struct{}{"sales.order:export": {}},
		CompanyIDs:  []uuid.UUID{uuid.New()},
	}, RenderInput{
		Resource: "sales.order", Mode: RenderModeExport,
		TemplateID: template.ID, IDs: []uuid.UUID{fx.orderIDs[0]},
	})
	if codeOf(err) != apierror.CodeNotFound {
		t.Fatalf("越公司读取错误 = %#v", err)
	}

	// 批量上限
	tooMany := make([]uuid.UUID, maxRenderBatch+1)
	for i := range tooMany {
		tooMany[i] = uuid.New()
	}
	_, err = service.Render(ctx, actor, RenderInput{
		Resource: "sales.order", Mode: RenderModeExport,
		TemplateID: template.ID, IDs: tooMany,
	})
	if codeOf(err) != apierror.CodeValidation || !strings.Contains(err.Error(), "单次最多处理 100 条") {
		t.Fatalf("超限错误 = %#v", err)
	}
}

func seedSalesOrderRenderFixture(
	t *testing.T, ctx context.Context, pool *pgxpool.Pool,
) *salesOrderRenderFixture {
	t.Helper()
	suffix := strings.ReplaceAll(uuid.NewString(), "-", "")[:10]
	fx := &salesOrderRenderFixture{
		companyID: uuid.New(), currencyID: uuid.New(), customerID: uuid.New(),
		unitID: uuid.New(), categoryID: uuid.New(), materialID: uuid.New(),
		orderIDs: []uuid.UUID{uuid.New(), uuid.New()}, suffix: suffix,
	}
	secondMaterialID := uuid.New()
	batch := &pgx.Batch{}
	batch.Queue(`INSERT INTO bas_currency(id,name,iso_code,active) VALUES($1,$2,$3,true)`,
		fx.currencyID, "打印币-"+suffix, "P"+suffix)
	batch.Queue(`INSERT INTO bas_company(id,code,name,short_name,base_currency_id)
		VALUES($1,$2,$3,$4,$5)`,
		fx.companyID, "PC"+suffix, "打印公司-"+suffix, "打"+suffix, fx.currencyID)
	batch.Queue(`INSERT INTO sal_customers(id,code,name) VALUES($1,$2,$3)`,
		fx.customerID, "CU"+suffix, "打印客户-"+suffix)
	batch.Queue(`INSERT INTO bas_unit(id,unit_type,is_base,name,symbol,ratio)
		VALUES($1,'quantity',true,$2,$3,1)`,
		fx.unitID, "打印个-"+suffix, "P"+suffix)
	batch.Queue(`INSERT INTO inv_material_category(id,code,name,is_leaf,active)
		VALUES($1,$2,$3,true,true)`, fx.categoryID, "PM"+suffix, "打印分类-"+suffix)
	batch.Queue(`INSERT INTO inv_material(id,code,name,spec,category_id,default_unit_id,
		is_customer_material,customer_id) VALUES($1,$2,$3,'规格一',$4,$5,false,NULL),
		($6,$7,$8,'规格二',$4,$5,false,NULL)`,
		fx.materialID, "PM"+suffix, "打印物料-"+suffix, fx.categoryID, fx.unitID,
		secondMaterialID, "PN"+suffix, "打印物料二-"+suffix)
	// 单 1：两条目；单 2：一条目
	batch.Queue(`INSERT INTO sal_order(id,order_no,order_date,party_type,party_id,status,
		company_id,currency_id,order_type,exchange_rate)
		VALUES($1,$2,CURRENT_DATE,'customer',$3,'draft',$4,$5,'regular',1),
		($6,$7,CURRENT_DATE,'customer',$3,'draft',$4,$5,'regular',1)`,
		fx.orderIDs[0], "PRT"+suffix, fx.customerID, fx.companyID, fx.currencyID,
		fx.orderIDs[1], "PRB"+suffix)
	batch.Queue(`INSERT INTO sal_order_item(id,idx,qty,base_qty,price,amount,base_price,
		base_amount,tax_rate,material_code,material_name,unit_name,order_id,company_id,
		material_id,unit_id,shipped_qty)
		VALUES(gen_random_uuid(),1,2,2,10,20,10,20,0,$1,$2,$3,$4,$5,$6,$7,0),
		(gen_random_uuid(),2,3,3,10,30,10,30,0,$8,$9,$3,$4,$5,$10,$7,0),
		(gen_random_uuid(),1,1,1,5,5,5,5,0,$1,$2,$3,$11,$5,$6,$7,0)`,
		"PM"+suffix, "打印物料-"+suffix, "打印个-"+suffix, fx.orderIDs[0], fx.companyID,
		fx.materialID, fx.unitID, "PN"+suffix, "打印物料二-"+suffix, secondMaterialID,
		fx.orderIDs[1])
	results := pool.SendBatch(ctx, batch)
	if err := results.Close(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cleanupCancel()
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM sal_order WHERE company_id=$1", fx.companyID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM inv_material WHERE category_id=$1", fx.categoryID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM inv_material_category WHERE id=$1", fx.categoryID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM bas_unit WHERE id=$1", fx.unitID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM sal_customers WHERE id=$1", fx.customerID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM bas_company WHERE id=$1", fx.companyID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM bas_currency WHERE id=$1", fx.currencyID)
	})
	return fx
}
