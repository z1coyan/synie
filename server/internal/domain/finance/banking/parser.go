package banking

import (
	"archive/zip"
	"bytes"
	"encoding/binary"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"math"
	"path"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/shopspring/decimal"
)

const (
	maxImportRows    = 5000
	excelFormatError = "无法读取文件:仅支持 Excel 的 xlsx/xls 格式" +
		"(部分银行导出的“xls”实为网页或文本,请用 Excel 打开后另存为 xlsx 再试)"
)

type cellKind uint8

const (
	cellText cellKind = iota
	cellDate
	cellTime
	cellDatetime
)

type sheetCell struct {
	text   string
	native time.Time
	kind   cellKind
}

type sheetRow map[int]sheetCell

func parseBankImport(
	template BankImportTemplate, content []byte, utcOffset time.Duration,
) ([]BankImportItem, error) {
	var (
		rows []sheetRow
		err  error
	)
	switch {
	case len(content) >= 2 && bytes.Equal(content[:2], []byte{'P', 'K'}):
		rows, err = readXLSX(content)
	case len(content) >= 8 &&
		bytes.Equal(content[:8], []byte{0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1}):
		rows, err = readBIFF8(content)
	default:
		return nil, errors.New(excelFormatError)
	}
	if err != nil {
		return nil, err
	}
	return buildImportItems(template, rows, utcOffset)
}

func buildImportItems(
	template BankImportTemplate, rows []sheetRow, utcOffset time.Duration,
) ([]BankImportItem, error) {
	columns := map[string]int{
		"datetime": colIndex(template.DatetimeCol), "date": colIndex(template.DateCol),
		"time": colIndex(template.TimeCol), "income": colIndex(template.IncomeCol),
		"expense": colIndex(template.ExpenseCol), "amount": colIndex(template.AmountCol),
		"balance":             colIndex(template.BalanceCol),
		"counterpartyName":    colIndex(template.CounterpartyNameCol),
		"counterpartyAccount": colIndex(template.CounterpartyAccountCol),
		"summary":             colIndex(template.SummaryCol), "note": colIndex(template.NoteCol),
	}
	start := int(template.StartRow)
	if start < 1 {
		start = 1
	}
	result := make([]BankImportItem, 0)
	for rowIndex := start - 1; rowIndex < len(rows); rowIndex++ {
		row := rows[rowIndex]
		if importRowBlank(row, columns) {
			continue
		}
		item := buildImportItem(template, row, columns, int64(rowIndex+1), utcOffset)
		result = append(result, item)
		if len(result) > maxImportRows {
			return nil, fmt.Errorf("数据行超过上限 %d 行,请拆分文件后分次导入", maxImportRows)
		}
	}
	if len(result) == 0 {
		return nil, fmt.Errorf("没有可解析的数据行(数据起始行:第 %d 行)", template.StartRow)
	}
	return result, nil
}

func buildImportItem(
	template BankImportTemplate, row sheetRow, columns map[string]int,
	rowNo int64, utcOffset time.Duration,
) BankImportItem {
	var messages []string
	occurredAt, err := parseImportOccurredAt(template, row, columns, utcOffset)
	if err != nil {
		messages = append(messages, err.Error())
	}
	income, expense, amountErrors := parseImportAmounts(template, row, columns)
	messages = append(messages, amountErrors...)
	balance, balanceErr := parseImportDecimal(importCell(row, columns["balance"]))
	if balanceErr != nil {
		messages = append(messages, "余额「"+balanceErr.Error()+"」无法解析")
		balance = nil
	}
	textCell, textOK := importCell(row, columns["counterpartyName"])
	counterpartyName, textErr := parseImportText(textCell, textOK, 128, "对方户名")
	if textErr != nil {
		messages = append(messages, textErr.Error())
	}
	textCell, textOK = importCell(row, columns["counterpartyAccount"])
	counterpartyAccount, textErr := parseImportText(textCell, textOK, 64, "对方账号")
	if textErr != nil {
		messages = append(messages, textErr.Error())
	}
	textCell, textOK = importCell(row, columns["summary"])
	summary, textErr := parseImportText(textCell, textOK, 255, "摘要")
	if textErr != nil {
		messages = append(messages, textErr.Error())
	}
	textCell, textOK = importCell(row, columns["note"])
	note, textErr := parseImportText(textCell, textOK, 255, "备注")
	if textErr != nil {
		messages = append(messages, textErr.Error())
	}
	var itemError *string
	if len(messages) > 0 {
		value := strings.Join(messages, ";")
		itemError = &value
	}
	return BankImportItem{
		RowNo: rowNo, OccurredAt: occurredAt, Income: income, Expense: expense,
		Balance: balance, CounterpartyName: counterpartyName,
		CounterpartyAccount: counterpartyAccount, Summary: summary, Note: note,
		Error: itemError,
	}
}

func parseImportOccurredAt(
	template BankImportTemplate, row sheetRow, columns map[string]int, utcOffset time.Duration,
) (*time.Time, error) {
	if template.DatetimeCol != nil {
		cell, ok := importCell(row, columns["datetime"])
		if !ok {
			return nil, errors.New("交易时间为空")
		}
		var local time.Time
		if cell.kind != cellText {
			local = cell.native
		} else {
			parsed, ok := parseTemplateDatetime(deref(template.DatetimeFormat), cell.text)
			if !ok {
				return nil, fmt.Errorf("交易时间「%s」不符合格式 %s",
					cell.text, datetimeFormatLabel(deref(template.DatetimeFormat)))
			}
			local = parsed
		}
		value := local.Add(-utcOffset).UTC()
		return &value, nil
	}
	dateCell, ok := importCell(row, columns["date"])
	if !ok {
		return nil, errors.New("交易日期为空")
	}
	var date time.Time
	if dateCell.kind != cellText {
		date = dateCell.native
	} else {
		parsed, valid := parseTemplateDate(deref(template.DateFormat), dateCell.text)
		if !valid {
			return nil, fmt.Errorf("交易日期「%s」不符合格式 %s",
				dateCell.text, dateFormatLabel(deref(template.DateFormat)))
		}
		date = parsed
	}
	var hour, minute, second int
	if timeCell, exists := importCell(row, columns["time"]); exists {
		if timeCell.kind != cellText {
			hour, minute, second = timeCell.native.Clock()
		} else {
			parsed, valid := parseTemplateTime(deref(template.TimeFormat), timeCell.text)
			if !valid {
				return nil, fmt.Errorf("交易时间「%s」不符合格式 %s",
					timeCell.text, timeFormatLabel(deref(template.TimeFormat)))
			}
			hour, minute, second = parsed.Clock()
		}
	}
	local := time.Date(date.Year(), date.Month(), date.Day(), hour, minute, second, 0, time.UTC)
	value := local.Add(-utcOffset).UTC()
	return &value, nil
}

func parseImportAmounts(
	template BankImportTemplate, row sheetRow, columns map[string]int,
) (*decimal.Decimal, *decimal.Decimal, []string) {
	if template.AmountCol != nil {
		amount, err := parseImportDecimal(importCell(row, columns["amount"]))
		if err != nil {
			return nil, nil, []string{"金额「" + err.Error() + "」无法解析"}
		}
		if amount == nil {
			return nil, nil, []string{"金额为空"}
		}
		switch amount.Sign() {
		case 1:
			return amount, nil, nil
		case -1:
			value := amount.Abs()
			return nil, &value, nil
		default:
			return nil, nil, []string{"金额为零"}
		}
	}
	income, incomeErr := parseImportDecimal(importCell(row, columns["income"]))
	if incomeErr != nil {
		return nil, nil, []string{"收入「" + incomeErr.Error() + "」无法解析"}
	}
	if income != nil && income.IsNegative() {
		return nil, nil, []string{"收入为负数,请检查金额列配置(负值请用带符号金额列模式)"}
	}
	expense, expenseErr := parseImportDecimal(importCell(row, columns["expense"]))
	if expenseErr != nil {
		return nil, nil, []string{"支出「" + expenseErr.Error() + "」无法解析"}
	}
	if expense != nil && expense.IsNegative() {
		return nil, nil, []string{"支出为负数,请检查金额列配置(负值请用带符号金额列模式)"}
	}
	if income != nil && income.IsZero() {
		income = nil
	}
	if expense != nil && expense.IsZero() {
		expense = nil
	}
	switch {
	case income == nil && expense == nil:
		return nil, nil, []string{"收入/支出均为空"}
	case income != nil && expense != nil:
		return nil, nil, []string{"收入与支出同时有值"}
	default:
		return income, expense, nil
	}
}

func parseImportDecimal(cell sheetCell, ok bool) (*decimal.Decimal, error) {
	if !ok {
		return nil, nil
	}
	raw := cellTextValue(cell)
	normalized := strings.NewReplacer(
		",", "", "，", "", " ", "", "¥", "", "￥", "",
	).Replace(raw)
	normalized = strings.TrimPrefix(normalized, "+")
	value, err := decimal.NewFromString(normalized)
	if err != nil {
		return nil, errors.New(raw)
	}
	return &value, nil
}

func parseImportText(cell sheetCell, ok bool, max int, label string) (*string, error) {
	if !ok {
		return nil, nil
	}
	value := cellTextValue(cell)
	if utf8.RuneCountInString(value) > max {
		return nil, fmt.Errorf("%s超过 %d 字", label, max)
	}
	return &value, nil
}

func importCell(row sheetRow, column int) (sheetCell, bool) {
	if column < 1 {
		return sheetCell{}, false
	}
	cell, ok := row[column]
	if !ok || (cell.kind == cellText && strings.TrimSpace(cell.text) == "") {
		return sheetCell{}, false
	}
	cell.text = strings.TrimSpace(cell.text)
	return cell, true
}

func importRowBlank(row sheetRow, columns map[string]int) bool {
	for _, column := range columns {
		if _, ok := importCell(row, column); ok {
			return false
		}
	}
	return true
}

func colIndex(column *string) int {
	if column == nil {
		return 0
	}
	result := 0
	for _, char := range strings.ToUpper(*column) {
		if char < 'A' || char > 'Z' {
			return 0
		}
		result = result*26 + int(char-'A'+1)
	}
	return result
}

func cellTextValue(cell sheetCell) string {
	if cell.kind == cellText {
		return cell.text
	}
	switch cell.kind {
	case cellDate:
		return cell.native.Format(time.DateOnly)
	case cellTime:
		return cell.native.Format(time.TimeOnly)
	default:
		return cell.native.Format("2006-01-02 15:04:05")
	}
}

func deref(value *string) string {
	if value == nil {
		return ""
	}
	return upper(*value)
}

func parseTemplateDatetime(format, value string) (time.Time, bool) {
	layouts := map[string]string{
		"YMD_DASH_HMS": "2006-1-2 15:4:5", "YMD_DASH_HM": "2006-1-2 15:4",
		"YMD_SLASH_HMS": "2006/1/2 15:4:5", "YMD_SLASH_HM": "2006/1/2 15:4",
		"COMPACT_SPACE": "20060102 150405", "COMPACT": "20060102150405",
		"ISO_T": "2006-1-2T15:4:5", "CN_HMS": "2006年1月2日 15:4:5",
		"MDY_SLASH_HMS": "1/2/2006 15:4:5", "DMY_SLASH_HMS": "2/1/2006 15:4:5",
	}
	return parseTemplateTimeLayout(layouts[format], value)
}

func parseTemplateDate(format, value string) (time.Time, bool) {
	layouts := map[string]string{
		"YMD_DASH": "2006-1-2", "YMD_SLASH": "2006/1/2",
		"YMD_COMPACT": "20060102", "YMD_DOT": "2006.1.2",
		"YMD_CN": "2006年1月2日", "MDY_SLASH": "1/2/2006",
		"DMY_SLASH": "2/1/2006", "DMY_DASH": "2-1-2006",
	}
	return parseTemplateTimeLayout(layouts[format], value)
}

func parseTemplateTime(format, value string) (time.Time, bool) {
	layouts := map[string]string{
		"HMS": "15:4:5", "HM": "15:4", "HMS_COMPACT": "150405",
		"HMS_CN": "15时4分5秒",
	}
	return parseTemplateTimeLayout(layouts[format], value)
}

func parseTemplateTimeLayout(layout, value string) (time.Time, bool) {
	if layout == "" {
		return time.Time{}, false
	}
	result, err := time.ParseInLocation(layout, value, time.UTC)
	return result, err == nil
}

func datetimeFormatLabel(value string) string {
	return map[string]string{
		"YMD_DASH_HMS": "YYYY-MM-DD HH:mm:ss", "YMD_DASH_HM": "YYYY-MM-DD HH:mm",
		"YMD_SLASH_HMS": "YYYY/MM/DD HH:mm:ss", "YMD_SLASH_HM": "YYYY/MM/DD HH:mm",
		"COMPACT_SPACE": "YYYYMMDD HHmmss", "COMPACT": "YYYYMMDDHHmmss",
		"ISO_T": "YYYY-MM-DDTHH:mm:ss", "CN_HMS": "YYYY年MM月DD日 HH:mm:ss",
		"MDY_SLASH_HMS": "MM/DD/YYYY HH:mm:ss", "DMY_SLASH_HMS": "DD/MM/YYYY HH:mm:ss",
	}[value]
}

func dateFormatLabel(value string) string {
	return map[string]string{
		"YMD_DASH": "YYYY-MM-DD", "YMD_SLASH": "YYYY/MM/DD",
		"YMD_COMPACT": "YYYYMMDD", "YMD_DOT": "YYYY.MM.DD",
		"YMD_CN": "YYYY年MM月DD日", "MDY_SLASH": "MM/DD/YYYY",
		"DMY_SLASH": "DD/MM/YYYY", "DMY_DASH": "DD-MM-YYYY",
	}[value]
}

func timeFormatLabel(value string) string {
	return map[string]string{
		"HMS": "HH:mm:ss", "HM": "HH:mm", "HMS_COMPACT": "HHmmss",
		"HMS_CN": "HH时mm分ss秒",
	}[value]
}

type xlsxRelationship struct {
	ID     string `xml:"Id,attr"`
	Target string `xml:"Target,attr"`
	Type   string `xml:"Type,attr"`
}

type xlsxRelationships struct {
	Items []xlsxRelationship `xml:"Relationship"`
}

type xlsxSheet struct {
	Name string `xml:"name,attr"`
	RID  string `xml:"id,attr"`
}

type xlsxWorkbook struct {
	Properties struct {
		Date1904 bool `xml:"date1904,attr"`
	} `xml:"workbookPr"`
	Sheets []xlsxSheet `xml:"sheets>sheet"`
}

type xlsxRichText struct {
	Text string `xml:"t"`
	Runs []struct {
		Text string `xml:"t"`
	} `xml:"r"`
}

func (value xlsxRichText) String() string {
	var output strings.Builder
	output.WriteString(value.Text)
	for _, run := range value.Runs {
		output.WriteString(run.Text)
	}
	return output.String()
}

type xlsxSharedStrings struct {
	Items []xlsxRichText `xml:"si"`
}

type xlsxCell struct {
	Reference string       `xml:"r,attr"`
	Type      string       `xml:"t,attr"`
	Style     int          `xml:"s,attr"`
	Value     string       `xml:"v"`
	Inline    xlsxRichText `xml:"is"`
}

type xlsxRow struct {
	Number int        `xml:"r,attr"`
	Cells  []xlsxCell `xml:"c"`
}

type xlsxWorksheet struct {
	Rows []xlsxRow `xml:"sheetData>row"`
}

type xlsxStyles struct {
	Formats []struct {
		ID   int    `xml:"numFmtId,attr"`
		Code string `xml:"formatCode,attr"`
	} `xml:"numFmts>numFmt"`
	XFs []struct {
		FormatID int `xml:"numFmtId,attr"`
	} `xml:"cellXfs>xf"`
}

func readXLSX(content []byte) ([]sheetRow, error) {
	archive, err := zip.NewReader(bytes.NewReader(content), int64(len(content)))
	if err != nil {
		return nil, errors.New(excelFormatError)
	}
	files := make(map[string]*zip.File, len(archive.File))
	for _, file := range archive.File {
		files[path.Clean(file.Name)] = file
	}
	var workbook xlsxWorkbook
	if err := readXLSXPart(files, "xl/workbook.xml", &workbook); err != nil {
		return nil, errors.New(excelFormatError)
	}
	if len(workbook.Sheets) == 0 {
		return nil, errors.New("文件中没有工作表")
	}
	var relationships xlsxRelationships
	if err := readXLSXPart(files, "xl/_rels/workbook.xml.rels", &relationships); err != nil {
		return nil, errors.New(excelFormatError)
	}
	target := ""
	for _, relationship := range relationships.Items {
		if relationship.ID == workbook.Sheets[0].RID {
			target = relationship.Target
			break
		}
	}
	if target == "" {
		return nil, fmt.Errorf("工作表「%s」解析失败", workbook.Sheets[0].Name)
	}
	target = strings.TrimPrefix(target, "/")
	if !strings.HasPrefix(target, "xl/") {
		target = path.Join("xl", target)
	}
	var worksheet xlsxWorksheet
	if err := readXLSXPart(files, path.Clean(target), &worksheet); err != nil {
		return nil, fmt.Errorf("工作表「%s」解析失败", workbook.Sheets[0].Name)
	}
	var shared xlsxSharedStrings
	if _, ok := files["xl/sharedStrings.xml"]; ok {
		if err := readXLSXPart(files, "xl/sharedStrings.xml", &shared); err != nil {
			return nil, errors.New(excelFormatError)
		}
	}
	var styles xlsxStyles
	if _, ok := files["xl/styles.xml"]; ok {
		if err := readXLSXPart(files, "xl/styles.xml", &styles); err != nil {
			return nil, errors.New(excelFormatError)
		}
	}
	maxRow := 0
	for _, row := range worksheet.Rows {
		if row.Number > maxRow {
			maxRow = row.Number
		}
	}
	rows := make([]sheetRow, maxRow)
	for _, sourceRow := range worksheet.Rows {
		if sourceRow.Number < 1 {
			continue
		}
		row := make(sheetRow)
		for _, sourceCell := range sourceRow.Cells {
			column := xlsxColumn(sourceCell.Reference)
			if column < 1 {
				continue
			}
			cell, ok := convertXLSXCell(
				sourceCell, shared.Items, styles, workbook.Properties.Date1904,
			)
			if ok {
				row[column] = cell
			}
		}
		rows[sourceRow.Number-1] = row
	}
	return rows, nil
}

func readXLSXPart(files map[string]*zip.File, name string, target any) error {
	file := files[name]
	if file == nil {
		return osErrNotExist(name)
	}
	reader, err := file.Open()
	if err != nil {
		return err
	}
	defer reader.Close()
	decoder := xml.NewDecoder(io.LimitReader(reader, 256<<20))
	return decoder.Decode(target)
}

func osErrNotExist(name string) error {
	return fmt.Errorf("%s does not exist", name)
}

func convertXLSXCell(
	cell xlsxCell, shared []xlsxRichText, styles xlsxStyles, date1904 bool,
) (sheetCell, bool) {
	switch cell.Type {
	case "inlineStr":
		return sheetCell{text: cell.Inline.String()}, true
	case "s":
		index, err := strconv.Atoi(strings.TrimSpace(cell.Value))
		if err != nil || index < 0 || index >= len(shared) {
			return sheetCell{}, false
		}
		return sheetCell{text: shared[index].String()}, true
	case "b":
		if strings.TrimSpace(cell.Value) == "1" {
			return sheetCell{text: "true"}, true
		}
		return sheetCell{text: "false"}, true
	case "str", "e":
		return sheetCell{text: cell.Value}, true
	}
	raw := strings.TrimSpace(cell.Value)
	if raw == "" {
		return sheetCell{}, false
	}
	format := xlsxCellFormat(styles, cell.Style)
	kind := excelDateKind(format.id, format.code)
	if kind != cellText {
		serial, err := strconv.ParseFloat(raw, 64)
		if err == nil {
			return sheetCell{native: excelSerialTime(serial, date1904), kind: kind}, true
		}
	}
	return sheetCell{text: raw}, true
}

type excelFormat struct {
	id   int
	code string
}

func xlsxCellFormat(styles xlsxStyles, style int) excelFormat {
	if style < 0 || style >= len(styles.XFs) {
		return excelFormat{}
	}
	id := styles.XFs[style].FormatID
	for _, format := range styles.Formats {
		if format.ID == id {
			return excelFormat{id: id, code: format.Code}
		}
	}
	return excelFormat{id: id}
}

func xlsxColumn(reference string) int {
	result := 0
	for _, char := range reference {
		if char < 'A' || char > 'Z' {
			break
		}
		result = result*26 + int(char-'A'+1)
	}
	return result
}

func excelSerialTime(value float64, date1904 bool) time.Time {
	base := time.Date(1899, 12, 30, 0, 0, 0, 0, time.UTC)
	if date1904 {
		base = time.Date(1904, 1, 1, 0, 0, 0, 0, time.UTC)
	}
	days := math.Floor(value)
	fraction := value - days
	seconds := math.Round(fraction * 86400)
	return base.AddDate(0, 0, int(days)).Add(time.Duration(seconds) * time.Second)
}

func excelDateKind(id int, code string) cellKind {
	switch id {
	case 14, 15, 16, 17:
		return cellDate
	case 18, 19, 20, 21, 45, 46, 47:
		return cellTime
	case 22:
		return cellDatetime
	}
	if code == "" {
		return cellText
	}
	normalized := normalizeExcelFormat(code)
	hasDate := strings.ContainsAny(normalized, "yd")
	hasTime := strings.ContainsAny(normalized, "hs")
	if hasDate && hasTime {
		return cellDatetime
	}
	if hasDate {
		return cellDate
	}
	if hasTime {
		return cellTime
	}
	return cellText
}

func normalizeExcelFormat(code string) string {
	var result strings.Builder
	inQuote := false
	inBracket := false
	escaped := false
	for _, char := range strings.ToLower(code) {
		switch {
		case escaped:
			escaped = false
		case char == '\\':
			escaped = true
		case char == '"':
			inQuote = !inQuote
		case char == '[':
			inBracket = true
		case char == ']':
			inBracket = false
		case !inQuote && !inBracket:
			result.WriteRune(char)
		}
	}
	return result.String()
}

const (
	cfbFreeSector   = uint32(0xffffffff)
	cfbEndOfChain   = uint32(0xfffffffe)
	cfbFATSector    = uint32(0xfffffffd)
	cfbDIFATSector  = uint32(0xfffffffc)
	cfbMaxChainRead = 1 << 20
)

type compoundFile struct {
	data           []byte
	sectorSize     int
	miniSectorSize int
	miniCutoff     uint32
	fat            []uint32
	miniFAT        []uint32
	miniStream     []byte
	entries        []compoundDirectoryEntry
}

type compoundDirectoryEntry struct {
	name  string
	kind  byte
	start uint32
	size  uint64
}

func readBIFF8(content []byte) ([]sheetRow, error) {
	compound, err := parseCompoundFile(content)
	if err != nil {
		return nil, errors.New(excelFormatError)
	}
	var workbook []byte
	for _, entry := range compound.entries {
		if entry.kind == 2 && (entry.name == "Workbook" || entry.name == "Book") {
			workbook, err = compound.readStream(entry)
			break
		}
	}
	if err != nil || len(workbook) == 0 {
		return nil, errors.New(excelFormatError)
	}
	rows, err := parseBIFFWorkbook(workbook)
	if err != nil {
		return nil, errors.New(excelFormatError)
	}
	return rows, nil
}

func parseCompoundFile(content []byte) (*compoundFile, error) {
	if len(content) < 512 {
		return nil, io.ErrUnexpectedEOF
	}
	sectorShift := binary.LittleEndian.Uint16(content[30:32])
	miniShift := binary.LittleEndian.Uint16(content[32:34])
	if sectorShift < 9 || sectorShift > 12 || miniShift != 6 {
		return nil, errors.New("unsupported compound document")
	}
	file := &compoundFile{
		data: content, sectorSize: 1 << sectorShift, miniSectorSize: 1 << miniShift,
		miniCutoff: binary.LittleEndian.Uint32(content[56:60]),
	}
	fatSectorIDs := make([]uint32, 0, binary.LittleEndian.Uint32(content[44:48]))
	for offset := 76; offset+4 <= 512; offset += 4 {
		id := binary.LittleEndian.Uint32(content[offset : offset+4])
		if id != cfbFreeSector {
			fatSectorIDs = append(fatSectorIDs, id)
		}
	}
	nextDIFAT := binary.LittleEndian.Uint32(content[68:72])
	difatCount := binary.LittleEndian.Uint32(content[72:76])
	for count := uint32(0); count < difatCount && normalSector(nextDIFAT); count++ {
		sector, err := file.sector(nextDIFAT)
		if err != nil {
			return nil, err
		}
		for offset := 0; offset+4 < len(sector); offset += 4 {
			id := binary.LittleEndian.Uint32(sector[offset : offset+4])
			if id != cfbFreeSector {
				fatSectorIDs = append(fatSectorIDs, id)
			}
		}
		nextDIFAT = binary.LittleEndian.Uint32(sector[len(sector)-4:])
	}
	for _, id := range fatSectorIDs {
		sector, err := file.sector(id)
		if err != nil {
			return nil, err
		}
		for offset := 0; offset+4 <= len(sector); offset += 4 {
			file.fat = append(file.fat, binary.LittleEndian.Uint32(sector[offset:offset+4]))
		}
	}
	directory, err := file.readRegularChain(binary.LittleEndian.Uint32(content[48:52]))
	if err != nil {
		return nil, err
	}
	for offset := 0; offset+128 <= len(directory); offset += 128 {
		entry := directory[offset : offset+128]
		nameLength := int(binary.LittleEndian.Uint16(entry[64:66]))
		if nameLength < 2 || nameLength > 64 || nameLength%2 != 0 {
			continue
		}
		units := make([]uint16, 0, nameLength/2-1)
		for index := 0; index+2 < nameLength; index += 2 {
			units = append(units, binary.LittleEndian.Uint16(entry[index:index+2]))
		}
		file.entries = append(file.entries, compoundDirectoryEntry{
			name: string(utf16.Decode(units)), kind: entry[66],
			start: binary.LittleEndian.Uint32(entry[116:120]),
			size:  binary.LittleEndian.Uint64(entry[120:128]),
		})
	}
	var root compoundDirectoryEntry
	for _, entry := range file.entries {
		if entry.kind == 5 {
			root = entry
			break
		}
	}
	if root.kind != 5 {
		return nil, errors.New("compound root missing")
	}
	file.miniStream, err = file.readRegularChain(root.start)
	if err != nil {
		return nil, err
	}
	if uint64(len(file.miniStream)) > root.size {
		file.miniStream = file.miniStream[:root.size]
	}
	miniFATStart := binary.LittleEndian.Uint32(content[60:64])
	miniFATCount := binary.LittleEndian.Uint32(content[64:68])
	if miniFATCount > 0 && normalSector(miniFATStart) {
		miniFATBytes, readErr := file.readRegularChain(miniFATStart)
		if readErr != nil {
			return nil, readErr
		}
		maxBytes := int(miniFATCount) * file.sectorSize
		if maxBytes < len(miniFATBytes) {
			miniFATBytes = miniFATBytes[:maxBytes]
		}
		for offset := 0; offset+4 <= len(miniFATBytes); offset += 4 {
			file.miniFAT = append(file.miniFAT,
				binary.LittleEndian.Uint32(miniFATBytes[offset:offset+4]))
		}
	}
	return file, nil
}

func (file *compoundFile) sector(id uint32) ([]byte, error) {
	offset := (uint64(id) + 1) * uint64(file.sectorSize)
	end := offset + uint64(file.sectorSize)
	if end > uint64(len(file.data)) {
		return nil, io.ErrUnexpectedEOF
	}
	return file.data[offset:end], nil
}

func (file *compoundFile) readRegularChain(start uint32) ([]byte, error) {
	var result []byte
	seen := make(map[uint32]struct{})
	for id := start; normalSector(id); {
		if len(seen) > cfbMaxChainRead {
			return nil, errors.New("compound chain too long")
		}
		if _, exists := seen[id]; exists || int(id) >= len(file.fat) {
			return nil, errors.New("invalid compound chain")
		}
		seen[id] = struct{}{}
		sector, err := file.sector(id)
		if err != nil {
			return nil, err
		}
		result = append(result, sector...)
		id = file.fat[id]
	}
	return result, nil
}

func (file *compoundFile) readStream(entry compoundDirectoryEntry) ([]byte, error) {
	var (
		result []byte
		err    error
	)
	if entry.size < uint64(file.miniCutoff) {
		seen := make(map[uint32]struct{})
		for id := entry.start; normalSector(id); {
			if _, exists := seen[id]; exists || int(id) >= len(file.miniFAT) {
				return nil, errors.New("invalid compound mini chain")
			}
			seen[id] = struct{}{}
			offset := uint64(id) * uint64(file.miniSectorSize)
			end := offset + uint64(file.miniSectorSize)
			if end > uint64(len(file.miniStream)) {
				return nil, io.ErrUnexpectedEOF
			}
			result = append(result, file.miniStream[offset:end]...)
			id = file.miniFAT[id]
		}
	} else {
		result, err = file.readRegularChain(entry.start)
		if err != nil {
			return nil, err
		}
	}
	if uint64(len(result)) < entry.size {
		return nil, io.ErrUnexpectedEOF
	}
	return result[:entry.size], nil
}

func normalSector(id uint32) bool {
	return id != cfbFreeSector && id != cfbEndOfChain &&
		id != cfbFATSector && id != cfbDIFATSector
}

type biffRecord struct {
	id      uint16
	payload []byte
}

func biffRecords(content []byte) ([]biffRecord, error) {
	records := make([]biffRecord, 0)
	for offset := 0; offset+4 <= len(content); {
		id := binary.LittleEndian.Uint16(content[offset : offset+2])
		size := int(binary.LittleEndian.Uint16(content[offset+2 : offset+4]))
		offset += 4
		if size < 0 || offset+size > len(content) {
			return nil, io.ErrUnexpectedEOF
		}
		records = append(records, biffRecord{id: id, payload: content[offset : offset+size]})
		offset += size
		if id == 0x000a && offset >= len(content) {
			break
		}
	}
	return records, nil
}

func parseBIFFWorkbook(content []byte) ([]sheetRow, error) {
	records, err := biffRecords(content)
	if err != nil {
		return nil, err
	}
	var (
		firstSheet uint32
		shared     []string
		xfs        []uint16
		formats    = make(map[uint16]string)
		date1904   bool
	)
	for index, record := range records {
		switch record.id {
		case 0x0085: // BOUNDSHEET
			if firstSheet == 0 && len(record.payload) >= 8 {
				firstSheet = binary.LittleEndian.Uint32(record.payload[:4])
			}
		case 0x00e0: // XF
			if len(record.payload) >= 4 {
				xfs = append(xfs, binary.LittleEndian.Uint16(record.payload[2:4]))
			}
		case 0x041e: // FORMAT
			if len(record.payload) >= 5 {
				id := binary.LittleEndian.Uint16(record.payload[:2])
				value, _, parseErr := parseBIFFUnicode(record.payload[2:], true)
				if parseErr == nil {
					formats[id] = value
				}
			}
		case 0x0022: // DATEMODE
			date1904 = len(record.payload) >= 2 &&
				binary.LittleEndian.Uint16(record.payload[:2]) == 1
		case 0x00fc: // SST
			payload := append([]byte(nil), record.payload...)
			for next := index + 1; next < len(records) && records[next].id == 0x003c; next++ {
				payload = append(payload, records[next].payload...)
			}
			shared, _ = parseBIFFSST(payload)
		}
	}
	if firstSheet == 0 || int(firstSheet) >= len(content) {
		return nil, errors.New("first BIFF sheet missing")
	}
	sheetRecords, err := biffRecords(content[firstSheet:])
	if err != nil {
		return nil, err
	}
	rows := make([]sheetRow, 0)
	setCell := func(rowIndex, columnIndex int, cell sheetCell) {
		for len(rows) <= rowIndex {
			rows = append(rows, nil)
		}
		if rows[rowIndex] == nil {
			rows[rowIndex] = make(sheetRow)
		}
		rows[rowIndex][columnIndex+1] = cell
	}
	convertNumber := func(value float64, xf uint16) sheetCell {
		formatID := uint16(0)
		if int(xf) < len(xfs) {
			formatID = xfs[xf]
		}
		kind := excelDateKind(int(formatID), formats[formatID])
		if kind != cellText {
			return sheetCell{native: excelSerialTime(value, date1904), kind: kind}
		}
		return sheetCell{text: formatBIFFNumber(value)}
	}
	pendingFormulaRow, pendingFormulaColumn := -1, -1
	for _, record := range sheetRecords {
		payload := record.payload
		switch record.id {
		case 0x0203: // NUMBER
			if len(payload) >= 14 {
				row, column := biffCellPosition(payload)
				xf := binary.LittleEndian.Uint16(payload[4:6])
				value := math.Float64frombits(binary.LittleEndian.Uint64(payload[6:14]))
				setCell(row, column, convertNumber(value, xf))
			}
		case 0x027e: // RK
			if len(payload) >= 10 {
				row, column := biffCellPosition(payload)
				xf := binary.LittleEndian.Uint16(payload[4:6])
				setCell(row, column, convertNumber(decodeRK(payload[6:10]), xf))
			}
		case 0x00bd: // MULRK
			if len(payload) >= 12 {
				row := int(binary.LittleEndian.Uint16(payload[:2]))
				firstColumn := int(binary.LittleEndian.Uint16(payload[2:4]))
				count := (len(payload) - 6) / 6
				for index := 0; index < count; index++ {
					offset := 4 + index*6
					xf := binary.LittleEndian.Uint16(payload[offset : offset+2])
					setCell(row, firstColumn+index,
						convertNumber(decodeRK(payload[offset+2:offset+6]), xf))
				}
			}
		case 0x00fd: // LABELSST
			if len(payload) >= 10 {
				row, column := biffCellPosition(payload)
				index := binary.LittleEndian.Uint32(payload[6:10])
				if int(index) < len(shared) {
					setCell(row, column, sheetCell{text: shared[index]})
				}
			}
		case 0x0204: // LABEL
			if len(payload) >= 9 {
				row, column := biffCellPosition(payload)
				value, _, parseErr := parseBIFFUnicode(payload[6:], true)
				if parseErr == nil {
					setCell(row, column, sheetCell{text: value})
				}
			}
		case 0x0205: // BOOLERR
			if len(payload) >= 8 {
				row, column := biffCellPosition(payload)
				setCell(row, column, sheetCell{text: strconv.FormatBool(payload[6] != 0)})
			}
		case 0x0006: // FORMULA
			if len(payload) >= 14 && payload[6] == 0xff && payload[7] == 0xff {
				row, column := biffCellPosition(payload)
				switch payload[8] {
				case 0: // cached string follows in a STRING record
					pendingFormulaRow, pendingFormulaColumn = row, column
				case 1:
					setCell(row, column,
						sheetCell{text: strconv.FormatBool(payload[9] != 0)})
				case 2:
					setCell(row, column, sheetCell{text: biffErrorText(payload[9])})
				}
			} else if len(payload) >= 14 {
				row, column := biffCellPosition(payload)
				xf := binary.LittleEndian.Uint16(payload[4:6])
				value := math.Float64frombits(binary.LittleEndian.Uint64(payload[6:14]))
				setCell(row, column, convertNumber(value, xf))
			}
		case 0x0207: // STRING, cached result for the preceding formula
			if pendingFormulaRow >= 0 {
				value, _, parseErr := parseBIFFUnicode(payload, true)
				if parseErr == nil {
					setCell(pendingFormulaRow, pendingFormulaColumn, sheetCell{text: value})
				}
				pendingFormulaRow, pendingFormulaColumn = -1, -1
			}
		case 0x000a: // EOF
			return rows, nil
		}
	}
	return rows, nil
}

func biffErrorText(code byte) string {
	return map[byte]string{
		0x00: "#NULL!", 0x07: "#DIV/0!", 0x0f: "#VALUE!", 0x17: "#REF!",
		0x1d: "#NAME?", 0x24: "#NUM!", 0x2a: "#N/A",
	}[code]
}

func biffCellPosition(payload []byte) (int, int) {
	return int(binary.LittleEndian.Uint16(payload[:2])),
		int(binary.LittleEndian.Uint16(payload[2:4]))
}

func decodeRK(raw []byte) float64 {
	value := binary.LittleEndian.Uint32(raw)
	var result float64
	if value&2 != 0 {
		result = float64(int32(value) >> 2)
	} else {
		result = math.Float64frombits(uint64(value&^3) << 32)
	}
	if value&1 != 0 {
		result /= 100
	}
	return result
}

func formatBIFFNumber(value float64) string {
	if value == math.Trunc(value) && math.Abs(value) < 1e15 {
		return strconv.FormatInt(int64(value), 10)
	}
	return strconv.FormatFloat(value, 'f', -1, 64)
}

func parseBIFFSST(payload []byte) ([]string, error) {
	if len(payload) < 8 {
		return nil, io.ErrUnexpectedEOF
	}
	count := int(binary.LittleEndian.Uint32(payload[4:8]))
	result := make([]string, 0, count)
	offset := 8
	for len(result) < count && offset < len(payload) {
		value, consumed, err := parseBIFFUnicode(payload[offset:], true)
		if err != nil {
			return result, err
		}
		result = append(result, value)
		offset += consumed
	}
	return result, nil
}

func parseBIFFUnicode(payload []byte, longLength bool) (string, int, error) {
	lengthBytes := 1
	if longLength {
		lengthBytes = 2
	}
	if len(payload) < lengthBytes+1 {
		return "", 0, io.ErrUnexpectedEOF
	}
	charCount := int(payload[0])
	if longLength {
		charCount = int(binary.LittleEndian.Uint16(payload[:2]))
	}
	offset := lengthBytes
	flags := payload[offset]
	offset++
	richRuns := 0
	extendedSize := 0
	if flags&0x08 != 0 {
		if offset+2 > len(payload) {
			return "", 0, io.ErrUnexpectedEOF
		}
		richRuns = int(binary.LittleEndian.Uint16(payload[offset : offset+2]))
		offset += 2
	}
	if flags&0x04 != 0 {
		if offset+4 > len(payload) {
			return "", 0, io.ErrUnexpectedEOF
		}
		extendedSize = int(binary.LittleEndian.Uint32(payload[offset : offset+4]))
		offset += 4
	}
	width := 1
	if flags&0x01 != 0 {
		width = 2
	}
	charBytes := charCount * width
	end := offset + charBytes
	consumed := end + richRuns*4 + extendedSize
	if consumed > len(payload) {
		return "", 0, io.ErrUnexpectedEOF
	}
	if width == 1 {
		runes := make([]rune, charCount)
		for index, value := range payload[offset:end] {
			runes[index] = rune(value)
		}
		return string(runes), consumed, nil
	}
	units := make([]uint16, charCount)
	for index := range units {
		units[index] = binary.LittleEndian.Uint16(payload[offset+index*2 : offset+index*2+2])
	}
	return string(utf16.Decode(units)), consumed, nil
}
