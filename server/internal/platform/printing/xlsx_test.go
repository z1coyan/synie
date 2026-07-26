package printing

import (
	"archive/zip"
	"bytes"
	"testing"
)

func TestExtractPlaceholdersReadsOnlyFirstSheetAndSharedStrings(t *testing.T) {
	value := workbookFixture(t, map[string]string{
		"xl/workbook.xml":            `<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="A" sheetId="1" r:id="rId1"/><sheet name="B" sheetId="2" r:id="rId2"/></sheets></workbook>`,
		"xl/_rels/workbook.xml.rels": `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>`,
		"xl/sharedStrings.xml":       `<sst><si><t>${order_no}</t></si><si><r><t>${items.qty}</t></r><r><t> ${items._seq}</t></r></si></sst>`,
		"xl/worksheets/sheet1.xml":   `<worksheet><sheetData><row><c t="s"><v>0</v></c><c t="s"><v>1</v></c><c t="inlineStr"><is><t>${company.name}</t></is></c></row></sheetData></worksheet>`,
		"xl/worksheets/sheet2.xml":   `<worksheet><sheetData><row><c t="inlineStr"><is><t>${must_not_appear}</t></is></c></row></sheetData></worksheet>`,
	})

	got, err := ExtractPlaceholders(value)
	if err != nil {
		t.Fatal(err)
	}
	if joined(got.Fields) != "order_no" {
		t.Fatalf("fields = %#v", got.Fields)
	}
	if joined(got.Nested["company"]) != "name" ||
		joined(got.Nested["items"]) != "_seq,qty" ||
		len(got.Nested) != 2 {
		t.Fatalf("nested = %#v", got.Nested)
	}
}

func TestExtractPlaceholdersRejectsMalformedWorkbook(t *testing.T) {
	cases := []struct {
		name string
		data []byte
		want string
	}{
		{"not zip", []byte("nope"), "无法解析模板: 不是有效的 xlsx（zip）文件"},
		{"missing workbook", workbookFixture(t, map[string]string{}), "无法解析模板: 缺少 xl/workbook.xml"},
		{"missing relationships", workbookFixture(t, map[string]string{
			"xl/workbook.xml": `<workbook><sheets><sheet name="A" sheetId="1" id="rId1"/></sheets></workbook>`,
		}), "无法解析模板: 缺少 xl/_rels/workbook.xml.rels"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := ExtractPlaceholders(tc.data)
			if err == nil || err.Error() != tc.want {
				t.Fatalf("error = %#v, want %q", err, tc.want)
			}
		})
	}
}

func workbookFixture(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	for name, value := range files {
		entry, err := writer.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := entry.Write([]byte(value)); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func joined(values []string) string {
	var result string
	for index, value := range values {
		if index > 0 {
			result += ","
		}
		result += value
	}
	return result
}
