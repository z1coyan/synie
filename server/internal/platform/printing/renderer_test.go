package printing

import (
	"archive/zip"
	"bytes"
	"errors"
	"io"
	"regexp"
	"strings"
	"testing"
)

// 读回工具：解包渲染产物，取指定 part 文本。
func readPart(t *testing.T, value []byte, name string) string {
	t.Helper()
	reader, err := zip.NewReader(bytes.NewReader(value), int64(len(value)))
	if err != nil {
		t.Fatalf("产物不是有效 zip: %v", err)
	}
	for _, entry := range reader.File {
		if entry.Name == name {
			stream, openErr := entry.Open()
			if openErr != nil {
				t.Fatal(openErr)
			}
			raw, readErr := io.ReadAll(stream)
			_ = stream.Close()
			if readErr != nil {
				t.Fatal(readErr)
			}
			return string(raw)
		}
	}
	t.Fatalf("产物缺少 part %s", name)
	return ""
}

func partNames(t *testing.T, value []byte) []string {
	t.Helper()
	reader, err := zip.NewReader(bytes.NewReader(value), int64(len(value)))
	if err != nil {
		t.Fatal(err)
	}
	names := make([]string, 0, len(reader.File))
	for _, entry := range reader.File {
		names = append(names, entry.Name)
	}
	return names
}

// sheetCellTexts 取出 sheet XML 中全部 inline 文本。
func sheetCellTexts(sheet string) []string {
	pattern := regexp.MustCompile(`<t[^>]*>([^<]*)</t>`)
	result := make([]string, 0)
	for _, match := range pattern.FindAllStringSubmatch(sheet, -1) {
		result = append(result, xmlUnescape(match[1]))
	}
	return result
}

func rowNumbers(sheet string) []string {
	pattern := regexp.MustCompile(`<row\b[^>]*\br="(\d+)"`)
	result := make([]string, 0)
	for _, match := range pattern.FindAllStringSubmatch(sheet, -1) {
		result = append(result, match[1])
	}
	return result
}

const renderTestWorkbook = `<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
	`<sheets><sheet name="T" sheetId="1" r:id="rId1"/></sheets>` +
	`<definedNames><definedName name="_xlnm.Print_Area" localSheetId="0">'T'!$A$1:$C$4</definedName></definedNames>` +
	`</workbook>`

const renderTestRels = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
	`<Relationship Id="rId1" Target="worksheets/sheet1.xml"/>` +
	`<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
	`</Relationships>`

const renderTestContentTypes = `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
	`<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
	`<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
	`</Types>`

// 模板：行 1 头字段（sharedStrings 占位符），行 2 空行（无 <row> 元素，验证按最大行号偏移），
// 行 3 明细模板行（merge 落在循环行上应丢弃），行 4 尾注（merge A4:C4 顺移）。
func renderTestTemplate(t *testing.T) []byte {
	t.Helper()
	return workbookFixture(t, map[string]string{
		"xl/workbook.xml":            renderTestWorkbook,
		"xl/_rels/workbook.xml.rels": renderTestRels,
		"[Content_Types].xml":        renderTestContentTypes,
		"xl/styles.xml":              `<styleSheet/>`,
		"xl/sharedStrings.xml":       `<sst><si><t>订单号：${order_no}</t></si><si><t>${party.name}</t></si></sst>`,
		"xl/worksheets/sheet1.xml": `<worksheet><dimension ref="A1:C4"/>` +
			`<sheetData>` +
			`<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="inlineStr"><is><t>${unknown_key}</t></is></c></row>` +
			`<row r="3"><c r="A3" t="inlineStr"><is><t>${items._seq}</t></is></c><c r="B3" t="inlineStr"><is><t>${items.material_name}</t></is></c><c r="C3" t="inlineStr"><is><t>${items.qty}</t></is></c></row>` +
			`<row r="4"><c r="A4" t="inlineStr"><is><t>合计 ${gross_total}</t></is></c></row>` +
			`</sheetData>` +
			`<mergeCells count="2"><mergeCell ref="A3:C3"/><mergeCell ref="A4:C4"/></mergeCells>` +
			`<rowBreaks count="1" manualBreakCount="1"><brk id="1" max="16383" man="1"/></rowBreaks>` +
			`<pageSetup paperSize="9"/>` +
			`</worksheet>`,
	})
}

func renderTestDoc() PrintDoc {
	return PrintDoc{
		Fields: map[string]string{
			"order_no":    "SO-0001",
			"party.name":  "测试客户",
			"gross_total": "100.5",
		},
		Loops: map[string][]map[string]string{
			"items": {
				{"material_name": "物料甲", "qty": "2"},
				{"material_name": "物料乙", "qty": "3"},
			},
		},
	}
}

func TestRenderPagesFillsHeaderLoopsAndShiftsLayout(t *testing.T) {
	out, err := RenderPages(renderTestTemplate(t), []PrintDoc{renderTestDoc()})
	if err != nil {
		t.Fatal(err)
	}
	sheet := readPart(t, out, "xl/worksheets/sheet1.xml")
	texts := sheetCellTexts(sheet)
	joined := strings.Join(texts, "|")
	for _, want := range []string{"订单号：SO-0001", "测试客户", "1", "物料甲", "2", "物料乙", "3", "合计 100.5"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("文本 %q 未出现在 %q", want, joined)
		}
	}
	// 未知键填空，不留占位符原文
	if strings.Contains(sheet, "${") {
		t.Fatalf("产物残留占位符: %s", sheet)
	}
	// 2 条目展开为行 3、4，尾注顺移到行 5
	if got := strings.Join(rowNumbers(sheet), ","); got != "1,3,4,5" {
		t.Fatalf("行号 = %s, want 1,3,4,5", got)
	}
	// 循环行上的 merge 丢弃，尾注 merge 顺移
	if strings.Contains(sheet, `ref="A3:C3"`) {
		t.Fatalf("循环行 merge 未丢弃: %s", sheet)
	}
	if !strings.Contains(sheet, `ref="A5:C5"`) {
		t.Fatalf("尾注 merge 未顺移: %s", sheet)
	}
	// 模板自带手工分页符保留（brk id=1）
	if !strings.Contains(sheet, `<brk id="1"`) {
		t.Fatalf("手工分页符丢失: %s", sheet)
	}
	// pageSetup 等未改 part 原样保留
	if !strings.Contains(sheet, `<pageSetup paperSize="9"/>`) {
		t.Fatalf("pageSetup 丢失: %s", sheet)
	}
	if readPart(t, out, "xl/styles.xml") != `<styleSheet/>` {
		t.Fatal("styles part 被改动")
	}
}

func TestRenderPagesBatchBlocksOffsetsAndPrintArea(t *testing.T) {
	empty := PrintDoc{
		Fields: map[string]string{"order_no": "SO-0002", "party.name": "客户乙", "gross_total": "7"},
		Loops:  map[string][]map[string]string{"items": {}},
	}
	out, err := RenderPages(renderTestTemplate(t), []PrintDoc{renderTestDoc(), empty})
	if err != nil {
		t.Fatal(err)
	}
	sheet := readPart(t, out, "xl/worksheets/sheet1.xml")
	// 第一块占最大行号 5，第二块行号从 6 起（空行元素缺失按最大行号偏移，plans/001）；
	// 第二块 0 条目删除明细模板行后自身 max_row=3，展开为行 6 与行 8
	if got := strings.Join(rowNumbers(sheet), ","); got != "1,3,4,5,6,8" {
		t.Fatalf("行号 = %s, want 1,3,4,5,6,8", got)
	}
	// 第二块 0 条目：明细模板行整行删除（无行 7/8）
	texts := strings.Join(sheetCellTexts(sheet), "|")
	if !strings.Contains(texts, "订单号：SO-0002") {
		t.Fatalf("第二块头字段缺失: %s", texts)
	}
	// 块间分页符：第一块末行 5 之后分页；块自带 brk id=1 偏移后为 6
	if !strings.Contains(sheet, `<brk id="5"`) || !strings.Contains(sheet, `<brk id="6"`) {
		t.Fatalf("分页符不正确: %s", sheet)
	}
	// 打印区域按块复制并偏移
	wb := readPart(t, out, "xl/workbook.xml")
	if !strings.Contains(wb, "'T'!$A$1:$C$4,'T'!$A$6:$C$9") {
		t.Fatalf("打印区域未按块偏移: %s", wb)
	}
}

func TestRenderSheetsProducesOneSheetPerDoc(t *testing.T) {
	out, err := RenderSheets(renderTestTemplate(t), []NamedDoc{
		{Name: "SO-0001", Doc: renderTestDoc()},
		{Name: "SO/0002:超长单号截断测试用中文补齐三十一字节数统计一二三四五六七八九十", Doc: renderTestDoc()},
		{Name: "SO-0001", Doc: renderTestDoc()},
	})
	if err != nil {
		t.Fatal(err)
	}
	wb := readPart(t, out, "xl/workbook.xml")
	// 非法字符替换 + 重名去重；打印区域剥掉
	if strings.Contains(wb, "Print_Area") {
		t.Fatalf("导出 workbook 残留打印区域: %s", wb)
	}
	if !strings.Contains(wb, `name="SO-0001"`) || !strings.Contains(wb, `name="SO-0001 1"`) {
		t.Fatalf("sheet 名去重失败: %s", wb)
	}
	if strings.Contains(wb, "SO/0002") || !strings.Contains(wb, "SO 0002") {
		t.Fatalf("sheet 名非法字符未替换: %s", wb)
	}
	// 模板 sheet 被新 sheet 集替换
	names := partNames(t, out)
	count := 0
	for _, name := range names {
		if strings.HasPrefix(name, "xl/worksheets/sheet_synie_") {
			count++
		}
		if name == "xl/worksheets/sheet1.xml" {
			t.Fatalf("旧模板 sheet 未移除: %v", names)
		}
	}
	if count != 3 {
		t.Fatalf("导出 sheet 数 = %d, want 3 (%v)", count, names)
	}
	first := readPart(t, out, "xl/worksheets/sheet_synie_1.xml")
	if !strings.Contains(strings.Join(sheetCellTexts(first), "|"), "订单号：SO-0001") {
		t.Fatalf("导出 sheet 内容不正确: %s", first)
	}
	// rels 保留 styles 关系
	rels := readPart(t, out, "xl/_rels/workbook.xml.rels")
	if !strings.Contains(rels, "styles.xml") {
		t.Fatalf("styles 关系丢失: %s", rels)
	}
}

func TestRenderRejectsEmptyDocsAndInvalidTemplate(t *testing.T) {
	if _, err := RenderPages(nil, nil); !errors.Is(err, ErrEmptyDocs) {
		t.Fatalf("err = %v, want ErrEmptyDocs", err)
	}
	if _, err := RenderSheets(nil, nil); !errors.Is(err, ErrEmptyDocs) {
		t.Fatalf("err = %v, want ErrEmptyDocs", err)
	}
	if _, err := RenderPages([]byte("nope"), []PrintDoc{renderTestDoc()}); err == nil ||
		!strings.Contains(err.Error(), "不是有效的 xlsx") {
		t.Fatalf("err = %v", err)
	}
}

func TestRenderPagesTemplateWithoutLoopRow(t *testing.T) {
	template := workbookFixture(t, map[string]string{
		"xl/workbook.xml":            renderTestWorkbook,
		"xl/_rels/workbook.xml.rels": renderTestRels,
		"[Content_Types].xml":        renderTestContentTypes,
		"xl/worksheets/sheet1.xml": `<worksheet><sheetData>` +
			`<row r="1"><c r="A1" t="inlineStr"><is><t>单号 ${order_no}</t></is></c></row>` +
			`</sheetData></worksheet>`,
	})
	out, err := RenderPages(template, []PrintDoc{renderTestDoc()})
	if err != nil {
		t.Fatal(err)
	}
	sheet := readPart(t, out, "xl/worksheets/sheet1.xml")
	if !strings.Contains(strings.Join(sheetCellTexts(sheet), "|"), "单号 SO-0001") {
		t.Fatalf("无明细行模板渲染失败: %s", sheet)
	}
}
