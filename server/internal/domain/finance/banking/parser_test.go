package banking

import (
	"archive/zip"
	"bytes"
	"os"
	"testing"
	"time"

	"github.com/shopspring/decimal"
)

func TestParseBankImportXLSXRules(t *testing.T) {
	template := BankImportTemplate{
		StartRow: 2, DatetimeCol: strptr("A"), DatetimeFormat: strptr("YMD_DASH_HMS"),
		AmountCol: strptr("B"), BalanceCol: strptr("C"),
		CounterpartyNameCol: strptr("D"), SummaryCol: strptr("E"),
	}
	content := testXLSX(t, map[string]string{
		"A1": "交易时间", "B1": "金额", "C1": "余额", "D1": "对方", "E1": "摘要",
		"A2": "2026-07-01 10:30:00", "B2": "1,234.56", "C2": "5,000.00",
		"D2": "某某公司", "E2": "收入",
		"A3": "2026-07-02 08:00:00", "B3": "-88", "E3": "支出",
		"A4": "", "B4": "", "C4": "", "D4": "", "E4": "",
	})

	items, err := parseBankImport(template, content, 8*time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 2 {
		t.Fatalf("items = %#v", items)
	}
	if items[0].RowNo != 2 || items[0].OccurredAt == nil ||
		!items[0].OccurredAt.Equal(time.Date(2026, 7, 1, 2, 30, 0, 0, time.UTC)) ||
		items[0].Income == nil || items[0].Income.String() != "1234.56" ||
		items[0].Balance == nil ||
		!items[0].Balance.Equal(decimal.RequireFromString("5000.00")) ||
		items[0].Error != nil {
		t.Fatalf("first item = %#v", items[0])
	}
	if items[1].Expense == nil || items[1].Expense.String() != "88" ||
		items[1].Income != nil || items[1].Error != nil {
		t.Fatalf("second item = %#v", items[1])
	}
}

func TestParseBankImportBIFF8XLS(t *testing.T) {
	content, err := os.ReadFile(
		"../../../../../backend/apps/synie_core/test/support/fixtures/bank_import_sample.xls",
	)
	if err != nil {
		t.Fatal(err)
	}
	template := BankImportTemplate{
		StartRow: 2, DateCol: strptr("A"), DateFormat: strptr("YMD_DASH"),
		TimeCol: strptr("B"), TimeFormat: strptr("HMS"),
		IncomeCol: strptr("C"), ExpenseCol: strptr("D"), BalanceCol: strptr("E"),
		CounterpartyNameCol: strptr("F"), SummaryCol: strptr("G"),
	}
	items, err := parseBankImport(template, content, 8*time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 3 {
		t.Fatalf("items = %#v", items)
	}
	if items[0].Income == nil || items[0].Income.String() != "1234.56" ||
		items[0].OccurredAt == nil ||
		!items[0].OccurredAt.Equal(time.Date(2026, 7, 1, 2, 30, 0, 0, time.UTC)) {
		t.Fatalf("text row = %#v", items[0])
	}
	// The second row contains native Excel date/time cells. Native cell types
	// take precedence over the template's text format.
	if items[1].OccurredAt == nil ||
		!items[1].OccurredAt.Equal(time.Date(2026, 7, 2, 0, 30, 0, 0, time.UTC)) ||
		items[1].Income == nil || items[1].Income.String() != "100.5" {
		t.Fatalf("native row = %#v", items[1])
	}
	if items[2].Expense == nil || items[2].Expense.String() != "88" {
		t.Fatalf("expense row = %#v", items[2])
	}
}

func TestParseBankImportRejectsRenamedText(t *testing.T) {
	_, err := parseBankImport(BankImportTemplate{}, []byte("<html>not xls</html>"), 8*time.Hour)
	const expected = "无法读取文件:仅支持 Excel 的 xlsx/xls 格式(部分银行导出的“xls”实为网页或文本,请用 Excel 打开后另存为 xlsx 再试)"
	if err == nil || err.Error() != expected {
		t.Fatalf("err = %v", err)
	}
}

func testXLSX(t *testing.T, cells map[string]string) []byte {
	t.Helper()
	var output bytes.Buffer
	archive := zip.NewWriter(&output)
	files := map[string]string{
		"[Content_Types].xml":        `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
		"_rels/.rels":                `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
		"xl/workbook.xml":            `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
		"xl/_rels/workbook.xml.rels": `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
	}
	var sheet bytes.Buffer
	sheet.WriteString(`<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>`)
	for row := 1; row <= 4; row++ {
		sheet.WriteString(`<row r="` + string(rune('0'+row)) + `">`)
		for _, column := range []string{"A", "B", "C", "D", "E"} {
			ref := column + string(rune('0'+row))
			if value, ok := cells[ref]; ok {
				sheet.WriteString(`<c r="` + ref + `" t="inlineStr"><is><t>` +
					xmlEscape(value) + `</t></is></c>`)
			}
		}
		sheet.WriteString(`</row>`)
	}
	sheet.WriteString(`</sheetData></worksheet>`)
	files["xl/worksheets/sheet1.xml"] = sheet.String()
	for name, value := range files {
		writer, err := archive.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := writer.Write([]byte(value)); err != nil {
			t.Fatal(err)
		}
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	return output.Bytes()
}

func xmlEscape(value string) string {
	var output bytes.Buffer
	for _, char := range value {
		switch char {
		case '&':
			output.WriteString("&amp;")
		case '<':
			output.WriteString("&lt;")
		case '>':
			output.WriteString("&gt;")
		default:
			output.WriteRune(char)
		}
	}
	return output.String()
}
